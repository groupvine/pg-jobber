declare var Promise:any;
declare var require:any;
declare var module:any;

export enum JobState {
    New        = 0,
    Processing = 1,
    Completed  = 2,
    Archived   = 3,
    Failed     = 4,
    Terminated = 5
};

import {jobTableTmpl,
        jobIndexesTmpls,
        newJobTmpl,
        sendNotifyTmpl,
        regListenerTmpl,
        initCleanupTmpl,
        claimJobTmpl,
        getJobTmpl,
        activeJobsTmpl,
        completeJobTmpl,
        archiveJobTmpl,
        failedJobTmpl,
        removeJobTmpl}     from './db';

class Jobber {
    serverId    : string;
    options     : any;

    isReady     : boolean;

    db          : any;
    permConn    : any;   // permanent connection used to listen for notifications

    pendingJobs : any;
    jobHandlers : any;
    jobTimerIds : any;

    /**
     * A Postgres-based job scheduling utility 
     * for small- to medium-sized server clusters.
     *
     * Constructor, optionally invoked with serverId and 
     * Postgres configuration data (otherwise, must call .init() 
     * with this info).
     * 
     * @constructor Jobber
     * @param {string=} serverId
     * @param {Object=} pg
     * @param {Object=} options
     */

    constructor (serverId?:string, pg?:any, options?:any) {
        this.pendingJobs = {};
        this.jobHandlers = {};
        this.jobTimerIds = {};

        this.isReady     = false;

        if (serverId && pg) {
            this.init(serverId, pg, options);
        } else {
            this.serverId = null;
            this.options  = null;
            this.db       = null;
            this.permConn = null;
        }
    }

    /**
     * Initialize jobber (if not already done in construction).
     *
     * @method Jobber#init
     *
     * @param {string} serverId - Unique string identifying this server
     *
     * @param {Object} pg - pg-promise database connection object.
     *
     * @param {Object=} options  - Optional configuration info, with 
     *     properties: 'logger' {Bunyan compatible logger}; 
     *     'archiveJobs' {boolean} to archive rather than delete jobs
     *     from queue when done; 'maxWorkers' {integer} for the default
     *     maximum number of simultaneous worker processes per job type (defaults to 1); 
     *     'maxAttempts' {number} for the default maximum number of times to
     *     attempt jobs when encountering processing errors (defaults to 3); 
     *     'workerPool' {string} to allow separating job workers into different
     *     pools (still using same database), e.g., for administrator use, 
     *     test servers, or a high-volume customer; 'errorHandler(msg, err?)' {function} 
     *     callback function for errors getting passed an error msg and possibly an 
     *     Error object.
     *
     * @returns {void}
     */

    public init(serverId:string, pg:any, options?:any) {
        this.serverId = serverId;
        this.options  = options ? options : {};
        this.db       = pg;

        // set defaults
        if (!this.options.maxWorkers) {
            this.options.maxWorkers = 1;
        }

        if (!this.options.maxAttempts) {
            this.options.maxAttempts = 3;
        }

        let _this = this;

        return new Promise(function(resolve, reject) {
            // Check whether jobs table exists, and if not, create it

            _this.db.one("SELECT to_regclass('pgjobber_jobs')").then(results => {
                if (results.to_regclass !== null) {
                    // Already exists, so we're done
                    return Promise.resolve(false);
                }
                return _this.initDB();

            }).then( created => {
                if (created) {
                    _this.logInfo("Jobs table (pgjobber_jobs) created");
                }

                return _this.db.connect({direct : true});   // get a permanent connection

            }).then( permConn => {
                _this.permConn = permConn;

                // Add notification handler for this server
                _this.permConn.client.on('notification', _this.handleNotification.bind(_this));

                // Register to listen for this server's channel

                let promises = [];
                promises.push(_this.permConn.none(regListenerTmpl, {
                    channel : _this.serverId2Ch(_this.serverId)
                }));

                // Also register to listen for any already-registered 
                // worker handlers

                let chs = Object.keys(_this.jobHandlers);
                for (let i = 0; i < chs.length; i++) {
                    promises.push(_this.permConn.none(regListenerTmpl, {
                        channel : _this.jobType2Ch(chs[i])
                    }));
                }

                return Promise.all(promises);

            }).then( () => {

                return _this.initJobCleanup();

            }).then( () => {
                
                _this.isReady = true;
                resolve();

            }).catch(err => {
                _this.logError("pg-jobber init failed", err);
                reject();
            });
        });
    }

    /**
     * Cleanup stale/failed jobs that were started previously on
     * this server.
     */

    private initJobCleanup() {
        let startLimit = new Date();
        startLimit.setMinutes(startLimit.getMinutes() - 2); // handles negatives properly

        let startStr = startLimit.toISOString();
        let i = startStr.indexOf('.');
        if (i !== -1) {
            startStr = startStr.substring(0, i);
        }
        return this.db.any(initCleanupTmpl, {
            serverId   : this.serverId,
            startLimit : startStr,
            now        : this.date2Db(new Date())
        });
    }

    /**
     * Request a new job
     *
     * @method Jobber#request
     * 
     * @param {string} jobType - String identifying the job type and associated worker pool
     * @param {Object} instr   - Job-specific instructions
     * @param {Object=} options  - Has optional properties: 'priority' {number} 
     *       for integer job priority (priority 1 has most urgency, default 5).
     *
     * @returns {Promise.<Object>}  A promise that resolves with an object
     *     with 'results', original 'instrs', 'jobType', and 'priority' properties 
     */

    public request(jobType:string, instrs:any, options?:any) {
        if (!options) { options = {}; }
        let self  = this;
        let now   = new Date();

        if (!jobType) {
            let msg = "Received null jobType in call to Jobber.request()";
            this.logError(msg);
            throw Error(msg);
        }

        return new Promise( (resolve, reject) => {
            // Enqueue a new job request
            self.db.one(newJobTmpl, {
                requester : self.serverId,
                jobType   : jobType,
                instrs    : JSON.stringify(instrs),
                priority  : options.priority ? options.priority : 5,
                now       : self.date2Db(now)

            }).then(data => {
                self.pendingJobs[data.job_id] = {resolve : resolve, reject : reject};

                let jobInfo = {
                    notifyType : 'newJob',
                    jobId      : data.job_id,
                    jobType    : jobType
                };

                // always stringify payload, so can always JSON.parse()
                // on reception, regardless of whether original payload
                // is already a string or not.
                return self.db.none(sendNotifyTmpl, {
                    channel : self.jobType2Ch(jobType),
                    info    : JSON.stringify(jobInfo)
                });

            }).then( () => {
                // just return silently, don't resolve yet since
                // we need to wait for job-done notification
                return;
            }).catch(err => {
                let msg = "Fatal error in scheduling this job request";
                self.logError(msg, err);
                reject(msg);
            });
        });
    }

    /**
     * Handler callback
     *
     * @callback Jobber#handle#handlerCB(instrs, jobInfo)
     *
     * @param   {Object} instrs - Requested job instructions
     * @param   {Object} jobInfo - Job information data, including postgres 'job_id',
     *                   'attempts', 'requester', and 'priority'
     *
     *
     * @returns {any|Promise} The worker's response object or a Promise to the
     *          response, with the job results in the 'results' property.
     *          (If the job failed, then results.error contains an error object, with
     *           at least error.message.) Other properties are:
     *             'attempts' for the number of attempts required, and
     *             'instrs', 'jobType', and 'priority' with the job's original
     *              job type, instructions, and priority.
     */

    /**
     * Register a handler for a particular job type
     *
     * @method Jobber#handle
     * 
     * @param {string} jobType - String identifying the job type to be handled
     * @param {handlerCB} handlerCb - Callback to job handler function
     * @param {Object=} options  - Optional properties are: 'maxWorkers' {number}
     *     for the maximum number of simultaneous workers for this job type on 
     *     this server; 'maxAttempts' {number} for maximum number of times to
     *     attempt jobs of this type when encountering processing errors.
     *
     * @returns {void}
     */
    public handle(jobType:string, handlerCb:any, options:any) : void {
        if (!options) { options = {}; }

        this.logInfo(`Registering job handler for job type ${jobType}`);

        if (!jobType) {
            let msg = "Received null jobType in call to Jobber.handle()";
            this.logError(msg);
            throw Error(msg);
        }

        // Register this server as a handler for this jobType

        // TODO: Consider supporting timeouts
        // by making busyJobs an array of objects of type
        // busyJobs : [{ jobId : ..., timerId : ...}] 
        // and adding a timeout_ms to this jobHandlers object
        this.jobHandlers[jobType] = {
            cb          : handlerCb,
            busyJobs    : [], 
            maxWorkers  : options.maxWorkers  ? options.maxWorkers  : this.options.maxWorkers,
            maxAttempts : options.maxAttempts ? options.maxAttempts : this.options.maxAttempts
        };

        if (this.permConn) {
            this.permConn.none(regListenerTmpl, {
                channel : this.jobType2Ch(jobType)
            });
        }

        // Check right away for jobs pending on the queue
        this.scheduleWorker(jobType);
    }

    /**
     * Get the worker pool this Jobber is running in.  This
     * can be useful, for instance, by worker services 
     * creating modified URIs 
     * for content created to be returned to the user, so the user
     * remains connected to a given worker pool.
     *
     * @method Jobber#workerPool
     *
     * @returns {null|string}
     */
    public workerPool() : string {
        if (this.options.workerPool) {
            return this.options.workerPool;
        } else {
            return null;
        }
    }

    //
    // Private helper methods
    //

    private initDB() {
        let self = this;

        return new Promise(function(resolve, reject) {
            // TODO, confirm Postgres >= 9.6

            self.db.any(jobTableTmpl).then( results => {
                let promList = [];
                let prom;
                for (let i = 0; i < jobIndexesTmpls.length; i++) {
                    prom = self.db.any(jobIndexesTmpls[i]);
                    promList.push(prom);
                }

                return Promise.all(promList);
            }).then( results => {
                resolve(true);
            }).catch( err => {
                self.logError("pg-jobber unable to create database table", err);
                reject(err);
            });
        });
    }

    private handleNotification(notification:any) {
        // this.logInfo("Received notification: " + JSON.stringify(notification));

        let notifyData = JSON.parse(notification.payload);

        switch (notifyData.notifyType) {

        case 'newJob':
            let jobType = notifyData.jobType;
            this.scheduleWorker(jobType);
            break;

        case 'doneJob':
        case 'failedJob':
            this.handleDoneJobNotification(notifyData, notifyData.notifyType);
            break;

        default:
            this.logError(`Notification with notify type ${notifyData.notifyType}`);
        }
    }

    private availWorkers(jobType) {
        return Math.max(this.jobHandlers[jobType].maxWorkers -
                        this.jobHandlers[jobType].busyJobs.length,
                        0);
    }

    private scheduleWorker(jobType) {
        let _this = this;

        if (this.jobTimerIds[jobType]) {
            return;
        }

        if (! this.availWorkers(jobType)) {
            return;
        }

        this.logDebug(`Scheduling job ${jobType}`);

        this.jobTimerIds[jobType] = setTimeout(function() {
            _this.jobTimerIds[jobType] = null;
            if (_this.isReady) {
                _this.logDebug(`Attempting job with ${_this.jobHandlers[jobType].busyJobs.length} busy workers`);
                _this.attemptJob(jobType);
            } else {
                // waiting for service ready, reschedule
                _this.scheduleWorker(jobType);
            }
        }, this.isReady ? 10 : 200);
    }

    private attemptJob(jobType:string) {
        let self   = this;
        let jobData = null;

        if (!this.jobHandlers[jobType]) {
            this.logError(`Received new job notification for a jobType ${jobType} this server does not work on`);
            return;
        }

        if (! this.availWorkers(jobType)) {
            this.logDebug("No available workers, returning from attemptJob()");
            return;
        }

        let busyJobIds = this.jobHandlers[jobType].busyJobs;

        if ( (busyJobIds == null) || (busyJobIds.length === 0) ) {
            // So query doesn't break (0 is an invalid job_id)
            busyJobIds = [0];
        } else {
            // Create a copy in case the array is changed by another thread while issuing the DB query
            busyJobIds = JSON.parse(JSON.stringify(busyJobIds));
        }

        // Try to claim the job (or a job)
        this.db.oneOrNone(claimJobTmpl, {
            now        : this.date2Db(new Date()),
            serverId   : this.serverId,
            jobType    : jobType,
            busyJobIds : busyJobIds

        }).catch( err => {
            let len = busyJobIds ? busyJobIds.length : '(null busyJobIds)';
            let msg = `Error with server ${self.serverId} trying to claim job type: ${jobType} and ` +
                `with busyJobIds: ${JSON.stringify(busyJobIds)}; len: ${len}`;
            self.logError(msg, err);
            throw(msg);

        }).then(data => {
            if (!data) {
                // unable to claim a job, just throw a coded exception
                self.logDebug(`No more ${jobType} jobs, returning`);
                throw "no job";
            }

            self.fixDbDates(data);

            // Set job data.  Be sure busyJobs is set before scheduling 
            // new possible jobs so it's excluded from next job query
            jobData = data;
            self.jobHandlers[jobType].busyJobs.push(jobData.job_id);

            // We got a job, so schedule a check for more concurrent jobs
            self.scheduleWorker(jobType);

            self.logDebug(`Starting ${jobType} job ${jobData.job_id}: ${JSON.stringify(jobData.instrs)}`);

            // Invoke worker handler to process job
            let res = self.jobHandlers[jobType].cb(jobData.instrs, jobData);
            if (res.then instanceof Function) {
                return res; // it's a promise, so return it
            } else {
                return Promise.resolve(res);
            }

        }).then(res => {
            jobData.results = res;  // save results

            self.logDebug(`Finished ${jobType} job ${jobData.job_id}`);

            // Update job record as completed with results
            return self.db.any(completeJobTmpl, {
                results : JSON.stringify(res),
                now     : self.date2Db(new Date()),
                jobId   : jobData.job_id
            });

        }).then( () => {
            // Notify requester (don't send results or instrs
            // in case they are large, beyond 8k limit for 
            // notifications)
            let jobInfo = {
                notifyType : 'doneJob',
                jobId      : jobData.job_id,
                jobType    : jobType,
                priority   : jobData.priority,
                state      : JobState.Completed
            };

            self.logDebug(`Sending job done for job ${jobData.job_id}`);

            return self.db.none(sendNotifyTmpl, {
                channel : self.serverId2Ch(jobData.requester),
                info    : JSON.stringify(jobInfo)
            });

        }).then( () => {
            // done, try to get another job
            if (jobData) {
                self.removeFromList(self.jobHandlers[jobType].busyJobs,
                                    jobData.job_id);
            }

            self.scheduleWorker(jobType);
            return;

        }).catch(jobErr => {
            if (jobErr === "no job") {
                return;  // couldn't claim a job, so don't reschedule worker
            }

            self.logError(`Error processing job ${jobType} job ${jobData ? jobData.job_id : '?'}: ${JSON.stringify(jobErr)}`);

            if (jobErr.message == null) {
                jobErr = { message : jobErr.toString() };
            }

            if (!jobData) {
                self.scheduleWorker(jobType);
            } else {
                self.failedJobCheck(jobType, jobData, jobErr).then( () => {
                    self.removeFromList(self.jobHandlers[jobType].busyJobs,
                                        jobData.job_id);
                    self.scheduleWorker(jobType);
                }).catch( err => {
                    self.logError(`Error in failedJobCheck()!? ${jobData ? jobData.job_id : '?'}`, err);
                    throw(err);
                });
            }
        });
    }
        
    private failedJobCheck(jobType:string, jobData:any, err:any) {
        let self = this;

        return new Promise( (resolve, reject) => {
            if (jobData.attempts < self.jobHandlers[jobType].maxAttempts) {
                resolve();
            } else {
                // Update job record as failed
                self.db.any(failedJobTmpl, {
                    results : JSON.stringify({error : err}),
                    now     : self.date2Db(new Date()),
                    jobId   : jobData.job_id

                }).then( () => {
                    let jobInfo = {
                        notifyType : 'failedJob',
                        jobId      : jobData.job_id,
                        jobType    : jobType,
                        priority   : jobData.priority,
                        state      : JobState.Failed
                    };

                    self.db.none(sendNotifyTmpl, {
                        channel : self.serverId2Ch(jobData.requester),
                        info    : JSON.stringify(jobInfo)
                    });

                }).then( () => {
                    resolve();

                }).catch( err2 => {
                    reject(err2);
                });
            }
        });
    }

    
    private handleDoneJobNotification(notifyData:any, notifyType:string) {
        let self   = this;
        let jobId  = notifyData.jobId;

        self.logDebug(`Rcvd job done for job ${jobId}`);

        if (! this.pendingJobs[jobId]) {
            this.logError(`Rcvd job done (${notifyType}) for job ${jobId} that is not pending for this server ` +
                          `(perhaps already serviced, or enqueued prior to a server restart?)`);

            this.deleteJob(jobId, notifyType);
        } else {
            let cbFunc;
            if (notifyType === 'failedJob') {
                cbFunc = this.pendingJobs[jobId].reject;
            } else {
                cbFunc = this.pendingJobs[jobId].resolve;
            }

            // Remove from pending jobs (so can't resolve again)
            delete this.pendingJobs[jobId];

            self.db.one(getJobTmpl, {jobId : jobId}).then(data => {
                self.fixDbDates(data);

                let results = {
                    instrs   : data.instrs,
                    results  : data.results,
                    jobType  : data.job_type,
                    priority : data.priority,
                    attempts : data.attempts
                };
                cbFunc(results);

                // Delete (or archive) job, no need to
                // wait for it to be done
                self.deleteJob(jobId, notifyType);

            }).catch( err => {
                throw(err);
            });
        }
    }

    private deleteJob(jobId:number, notifyType:string) {
        if (notifyType === 'failedJob') {
            // Leave 'failed' status as is
            return;
        }

        let tmpl;
        if (this.options.archiveJobs) {
            tmpl = archiveJobTmpl;
        } else {
            tmpl = removeJobTmpl;
        }

        this.db.none(tmpl, {
            jobId : jobId
        });
    }

    private jobType2Ch(jobType:string) {
        let pool = '';
        if (this.options.workerPool) {
            pool = this.options.workerPool + ':';
        }
        return `pgjobber_${pool}_${jobType}`;
    }

    private serverId2Ch(serverId:string) {
        return `<pgjobber_${serverId}>`;
    }

    private removeFromList(listValue, value) {
        let index = listValue.indexOf(value);
        if (index > -1) {
            listValue.splice(index, 1);
        }
    }

    //
    // Database timestamp field handling
    //

    private date2Db(date:any) : string {
        // Convert local date to UTC
        let dbDateStr = date.toUTCString();

        // Then remove the "GMT" so the DB doesn't convert 
        // it back to local time for storage!
        dbDateStr = dbDateStr.substring(0, dbDateStr.length - 4);

        return dbDateStr;
    }

    private db2Date(dbDate:any) : any {
        let dbDateStr = dbDate + '';   // convert to string, just in case not

        let matches = dbDateStr.match(/^\s*\"(.+)\"\s*$/);
        if (matches) {
            // Remove outside quotes
            dbDateStr = matches[1];
        }

        // Add UTC
        let dateStr = dbDateStr + ' UTC';

        // Return JS Date
        return new Date(dateStr);
    }

    private fixDbDates(dbRec:any) {
        let dateFields = ['started', 'requested', 'completed'];
        for (let i = 0; i < dateFields.length; i++) {
            if (dateFields[i] in dbRec) {
                dbRec[dateFields[i]] = this.db2Date(dbRec[dateFields[i]]);
            }
        }
    }

    //
    // Logging
    //

    private logError(msg:string, err?:any) {
        // Note that if both an error handler and logger are 
        // provided, could end up with some redundant output
        // if the error handler also logs the error

        if (this.options.errorHandler) {
            this.options.errorHandler(msg, err);
        } 

        if (this.options.logger) {
            this.options.logger.error({err : err}, msg);
        } else {
            console.error(msg, err);
        }
    }

    private logInfo(msg:string) {
        if (this.options.logger) {
            this.options.logger.info(msg);
        } else {
            console.log(msg);
        }
    }

    private logDebug(msg:string) {
        if (this.options.logger) {
            this.options.logger.debug(msg);
        } else {
            console.log(msg);
        }
    }

    // 
    // Debugging support
    //


    // Attempt to run job, regardless of it's job state or whether another worker
    // is already processing it, and ignore results
    dbgAttemptJob(jobId:number) {
        let self = this;

        let jobType = null;
        let jobData = null;

        this.db.oneOrNone(getJobTmpl, {
            jobId : jobId
        }).then( data => {
            jobData = data;
            self.fixDbDates(jobData);
            jobType = jobData.job_type;

            let res = self.jobHandlers[jobType].cb(jobData.instrs, jobData);
            if (res.then instanceof Function) {
                return res; // it's a promise, so return it
            } else {
                return Promise.resolve(res);
            }

        }).then( res => {
            // Using logInfo to be sure it's printed... dbg function already being invoked
            self.logInfo(`DEBUG Finished ${jobType} job ${jobData.job_id} with results ${JSON.stringify(res)}`);

        }).catch( err => {
            self.logError(`DEBUG Caught error for ${jobType} job ${jobData.job_id} with err ${JSON.stringify(err)}`);
        });
    }

    dbgActiveJobs() {
        return this.db.any(activeJobsTmpl, {});
    }
}


module.exports = function(serverId, pgsql) {
    return new Jobber(serverId, pgsql);
};
