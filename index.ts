var pgp = require('pg-promise')();

export enum JobState {
    New        = 0,
    Processing = 1,
    Completed  = 2,
    Archived   = 3
};

declare var Promise:any;

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
    
    /**
     * A Postgres-based job scheduling utility 
     * for relatively small server clusters.
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
     *     properties: logger {Bunyan compatible logger}; 
     *     archiveJobs {boolean} to archive rather than delete jobs
     *     from queue when done.
     *
     * @returns {void}
     */

    public init(serverId:string, pgConfig:any, options?:any) {
        this.serverId = serverId;
        this.pgConfig = pgConfig;
        this.options  = options ? options : {};
        this.db       = pgp(pgConfig);

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
     *
     * @returns {void}
     */
    public handle(jobType:string, handlerCb:any) : void {
        // Register this server as a handler for this jobType
        this.jobHandlers[jobType] = {cb : handlerCb, busy : false};

        if (this.permConn) {
            this.permConn.none(regListenerTmpl, {
                channel : this.jobType2Ch(jobType)
            });
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

            if (! this.jobHandlers[jobType].busy) {
                // Not already processing a job of this type
                // (If so, will check after completing for more)
                this.jobHandlers[jobType].busy = true;
                this.handleNewJobNotification(jobType);
            }
            break;

        case 'doneJob':
            this.handleDoneJobNotification(notifyData);
            break;

        default:
            this.logError(`Notification with notify type ${notifyData.notifyType}`);
        }
    }

    private handleNewJobNotification(jobType:string) {
        let _this   = this;
        let jobData = null;

        if (!this.jobHandlers[jobType]) {
            this.logError(`Received new job notification for a jobType ${jobType} this server does not work on`);
            return;
        }

        // Try to claim the job (or a job)
        this.db.oneOrNone(claimJobTmpl, {
            now      : new Date(),
            serverId : this.serverId,
            jobType  : jobType

        }).then(data => {
            if (!data) {
                // unable to claim a job, just throw a coded exception
                throw "no job"
            }

            // Invoke worker handler to process job
            jobData = data;
            let res = _this.jobHandlers[jobType].cb(jobData.instrs);
            if (res.then instanceof Function) {
                return res; // it's a promise, so return it
            } else {
                return Promise.resolve(res);
            }

        }).then(res => {
            jobData.results = res;  // save results

            // Update job record as completed with results
            return _this.db.any(completeJobTmpl, {
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

            return _this.db.none(sendNotifyTmpl, {
                channel : _this.serverId2Ch(jobData.requester),
                info    : JSON.stringify(jobInfo)
            });

        }).then( () => {
            // done, try to get another job
            setTimeout(function() {
                _this.handleNewJobNotification(jobType);
            }, 10);
            return;

        }).catch(err => {
            // Done working on this job type
            _this.jobHandlers[jobType].busy = false;

            if (err === "no job") {
                return;  // couldn't claim a job
            }

            _this.logError("Error processing job", err);
        });
        
    }

    private handleDoneJobNotification(notifyData:any) {
        let _this   = this;

        if (! this.pendingJobs[notifyData.jobId]) {
            this.logError(`Received completed job notification for jobId ${notifyData.jobId} that is not pending for this server (perhaps already serviced, or enqueued prior to a server restart?)`);
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
}


module.exports = function(serverId, pgsql) {
    return new Jobber(serverId, pgsql);
}