declare var Promise:any;
declare var require:any;
declare var module:any;

var pgp = require('pg-promise')();

export enum JobState {
    New        = 0,
    Processing = 1,
    Completed  = 2,
    Archived   = 3,
    Failed     = 4
};

import {jobTableTmpl,
        jobIndexesTmpls,
        newJobTmpl,
        sendNotifyTmpl,
        regListenerTmpl,
        claimJobTmpl,
        getJobTmpl,
        completeJobTmpl,
        archiveJobTmpl,
        failedJobTmpl,
        removeJobTmpl}     from './db';

class Jobber {
    serverId    : string;
    options     : any;

    db          : any;
    permConn    : any;   // permanent connection used to listen for notifications
    
    pendingJobs : any;
    jobHandlers : any;
    jobTimerIds : any;

    /**
     * A Postgres-based job scheduling utility 
     * for small-ish server clusters.
     *
     * Constructor, optionally invoked with serverId and 
     * Postgres configuration data (otherwise, must call .init() 
     * with this info).
     * 
     * @constructor Jobber
     * @param {string=} serverId
     * @param {Object=} pgp
     * @param {Object=} options
     */

    constructor (serverId?:string, pgp?:any, options?:any) {
        this.pendingJobs = {};
        this.jobHandlers = {};
        this.jobTimerIds = {};

        if (serverId && pgp) {
            this.init(serverId, pgp, options);
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
     * @param {Object} pgp - pg-promise database connection object.
     *
     * @param {Object=} options  - Optional configuration info, with 
     *     properties: 'logger' {Bunyan compatible logger}; 
     *     'archiveJobs' {boolean} to archive rather than delete jobs
     *     from queue when done; 'maxWorkers' {integer} for the default
     *     maximum number of simultaneous worker processes per job type (defaults to 1); 
     *     'maxAttempts' {number} for the default maximum number of times to
     *     attempt jobs when encountering processing errors (defaults to 3); 
     *     'workerPool {string} to allow separating job workers into different
     *     pools (still using same database), e.g., for administrator use, 
     *     test servers, or a high-volume customer.
     *
     * @returns {void}
     */

    public init(serverId:string, pgp:any, options?:any) {
        this.serverId = serverId;
        this.options  = options ? options : {};
        this.db       = pgp;

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
                resolve();

            }).catch(err => {
                _this.logError("pg-jobber init failed", err);
                reject();
            });
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
            let msg = "Received null jobType in call to Jobber.request()"
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
     * @returns {any|Promise} The worker's response object or a Promise to the 
     *          response, with the job results in the 'results' property. 
     *          Other properties are: 
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
            let msg = "Received null jobType in call to Jobber.handle()"
            this.logError(msg);
            throw Error(msg);
        }

        // Register this server as a handler for this jobType
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

        let _this      = this;
        let notifyData = JSON.parse(notification.payload);

        switch (notifyData.notifyType) {

        case 'newJob':
            let jobType = notifyData.jobType
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
            _this.logDebug(`Attempting job with ${_this.jobHandlers[jobType].busyJobs.length} busy workers`);
            _this.attemptJob(jobType);
        }, 10);
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

        if (!busyJobIds.length) {
            // So query doesn't break (0 is an invalid job_id)
            busyJobIds = [0];   
        }

        // Try to claim the job (or a job)
        this.db.oneOrNone(claimJobTmpl, {
            now        : this.date2Db(new Date()),
            serverId   : this.serverId,
            jobType    : jobType,
            busyJobIds : busyJobIds

        }).then(data => {
            if (!data) {
                // unable to claim a job, just throw a coded exception
                self.logDebug(`No more ${jobType} jobs, returning`);
                throw "no job"
            }

            self.fixDbDates(data);

            // Set job data.  Be sure busyJobs is set before scheduling 
            // new possible jobs so it's excluded from next job query
            jobData = data;
            self.jobHandlers[jobType].busyJobs.push(jobData.job_id);
            
            // We got a job, so schedule a check for more concurrent jobs
            self.scheduleWorker(jobType);

            self.logDebug(`Starting ${jobType} job ${jobData.job_id}: ${jobData.instrs}`);

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
                this.removeFromList(self.jobHandlers[jobType].busyJobs,
                                    jobData.job_id);
            }

            self.scheduleWorker(jobType);
            return;

        }).catch(err => {
            if (err === "no job") {
                return;  // couldn't claim a job, so don't reschedule worker
            }

            if (!jobData) {
                self.scheduleWorker(jobType);
            } else {
                self.failedJobCheck(jobType, jobData).then( () => {
                    this.removeFromList(self.jobHandlers[jobType].busyJobs,
                                        jobData.job_id);
                    self.scheduleWorker(jobType);
                });
            }

            self.logError(`Error processing job ${jobData.job_id}`, err);
        });
        
    }

    private failedJobCheck(jobType:string, jobData:any) {
        let self = this;

        return new Promise( (resolve, reject) => {
            if (jobData.attempts < self.jobHandlers[jobType].maxAttempts) {
                resolve();
            } else {
                // Update job record as failed
                self.db.any(failedJobTmpl, {
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
                });

            }
        });
    }

    private handleDoneJobNotification(notifyData:any, notifyType:string) {
        let self   = this;
        let jobId  = notifyData.jobId;

        self.logDebug(`Rcvd job done for job ${jobId}`);

        if (! this.pendingJobs[jobId]) {
            this.logError(`Rcvd job done (${notifyType}) for job ${jobId} that is not pending for this server (perhaps already serviced, or enqueued prior to a server restart?)`);

            this.deleteJob(jobId);
        } else {
            let cbFunc;
            if (notifyType == 'failedJob') {
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
                self.deleteJob(jobId);
            });
        }
    }

    private deleteJob(jobId:number) {
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
            console.debug(msg);
        }
    }
}


module.exports = function(serverId, pgsql) {
    return new Jobber(serverId, pgsql);
}