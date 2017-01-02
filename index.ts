var pgp = require('pg-promise')();

declare var Promise:any;

export enum JobState {
    New        = 0,
    Processing = 1,
    Completed  = 2,
    Archived   = 3
};

import {jobTableTmpl,
        jobIndexesTmpls,
        newJobTmpl,
        sendNotifyTmpl,
        regListenerTmpl,
        claimJobTmpl,
        completeJobTmpl,
        archiveJobTmpl,
        removeJobTmpl}     from './db';

class Jobber {
    serverId    : string;
    pgConfig    : any;
    options     : any;

    db          : any;
    permConn    : any;   // permanent connection used to listen for notifications
    
    pendingJobs : any;
    jobHandlers : any;
    jobTimerId  : any;

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
     * @param {Object=} pgConfig
     * @param {Object=} options
     */

    constructor (serverId?:string, pgConfig?:any, options?:any) {
        this.pendingJobs = {};
        this.jobHandlers = {};
        this.jobTimerId  = null;

        if (serverId && pgConfig) {
            this.init(serverId, pgConfig, options);
        } else {
            this.serverId = null;
            this.pgConfig = null;
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
     * @param {Object} pgConfig - Postgres configuration, must include
     *     properties: host {string}, port {number}, database {string},
     *     user {string}, and password {string}.
     *
     * @param {Object=} options  - Optional configuration info, with 
     *     properties: 'logger' {Bunyan compatible logger}; 
     *     'archiveJobs' {boolean} to archive rather than delete jobs
     *     from queue when done; 'maxWorkers' {integer} for the default
     *     maximum number of simultaneous worker processes per job type.
     *
     * @returns {void}
     */

    public init(serverId:string, pgConfig:any, options?:any) {
        this.serverId = serverId;
        this.pgConfig = pgConfig;
        this.options  = options ? options : {};
        this.db       = pgp(pgConfig);

        // set defaults
        if (!this.options.maxWorkers) {
            this.options.maxWorkers = 1;
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
     * @param {number=} priority - Job priority (higher the greater, default 5)
     *
     * @returns {Promise.<Object>}  A promise that resolves with an object
     *     with 'results' and original 'instrs' properties
     */

    public request(jobType:string, instrs:any, priority?:number) {
        let self  = this;
        let now   = new Date();

        return new Promise( (resolve, reject) => {
            // Enqueue a new job request
            self.db.one(newJobTmpl, {
                requester : self.serverId,
                jobType   : jobType,
                instrs    : JSON.stringify(instrs),
                priority  : priority ? priority : 5,
                now       : now

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
                self.logError("New job request failed", err);
            });
        });
    }

    /**
     * Handler callback
     *
     * @callback Jobber#handle#handlerCB(instrs)
     *
     * @param   {Object} instrs - Requested job instructions
     * @returns {any|Promise} The job results or a Promise for the results
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
     *     this server.
     *
     * @returns {void}
     */
    public handle(jobType:string, handlerCb:any, options:any) : void {
        if (!options) { options = {}; }

        // Register this server as a handler for this jobType
        this.jobHandlers[jobType] = {
            cb         : handlerCb, 
            busyJobs   : [],
            maxWorkers : options.maxWorkers ? options.maxWorkers : this.options.maxWorkers
        };

        if (this.permConn) {
            this.permConn.none(regListenerTmpl, {
                channel : this.jobType2Ch(jobType)
            });
        }

        // Check right away for jobs pending on the queue
        this.scheduleWorker(jobType);
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
            this.handleDoneJobNotification(notifyData);
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

        if (this.jobTimerId) {
            return;
        }

        if (! this.availWorkers(jobType)) {
            return; 
        }

        this.logDebug(`Scheduling job ${jobType}`);

        this.jobTimerId = setTimeout(function() {
            _this.jobTimerId = null;
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
            now        : new Date(),
            serverId   : this.serverId,
            jobType    : jobType,
            busyJobIds : busyJobIds

        }).then(data => {
            if (!data) {
                // unable to claim a job, just throw a coded exception
                self.logDebug(`No more ${jobType} jobs, returning`);
                throw "no job"
            }

            // Set job data.  Be sure busyJobs is set before scheduling 
            // new possible jobs so it's excluded from next job query
            jobData = data;
            self.jobHandlers[jobType].busyJobs.push(jobData.job_id);
            
            // We got a job, so schedule a check for more concurrent jobs
            self.scheduleWorker(jobType);

            self.logDebug(`Starting ${jobType} job ${jobData.job_id}: ${jobData.instrs}`);

            // Invoke worker handler to process job
            let res = self.jobHandlers[jobType].cb(jobData.instrs);
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
                now     : new Date(),
                jobId   : jobData.job_id
            });
            
        }).then( () => {
            // Notify requester
            let jobInfo = {
                notifyType : 'doneJob',
                jobId      : jobData.job_id,
                instrs     : jobData.instrs,
                results    : jobData.results
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
                return;  // couldn't claim a job
            }

            if (jobData) {
                this.removeFromList(self.jobHandlers[jobType].busyJobs,
                                    jobData.job_id);
            }

            self.logError("Error processing job", err);
        });
        
    }

    private handleDoneJobNotification(notifyData:any) {
        let _this   = this;

        _this.logDebug(`Rcvd job done for job ${notifyData.jobId}`);

        if (! this.pendingJobs[notifyData.jobId]) {
            this.logError(`Rcvd job done for job ${notifyData.jobId} that is not pending for this server (perhaps already serviced, or enqueued prior to a server restart?)`);
        } else {
            // Call the associated resolve() method
            this.pendingJobs[notifyData.jobId].resolve({ 
                instrs  : notifyData.instrs, 
                results : notifyData.results
            });
            
            // Remove from pending jobs (so can't resolve again)
            delete this.pendingJobs[notifyData.jobId];
        }

        // Delete job from job queue

        let tmpl;
        if (this.options.archiveJobs) {
            tmpl = archiveJobTmpl;
        } else {
            tmpl = removeJobTmpl;
        }

        this.db.none(tmpl, {
            jobId : notifyData.jobId
        });
    }

    private jobType2Ch(jobType:string) {
        return `_${jobType}_`;
    }

    private serverId2Ch(serverId:string) {
        return `<${serverId}>`;
    }

    private removeFromList(listValue, value) {
        let index = listValue.indexOf(value);
        if (index > -1) {
            listValue.splice(index, 1);
        } 
    }

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