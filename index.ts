var pgp = require('pg-promise')();

declare var Promise:any;

import {jobTableDef,
        jobIndexesDefs} from './db';

class Jobber {
    serverId : string;
    pgConfig : any;
    options  : any;
    
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
        if (serverId && pgConfig) {
            this.init(serverId, pgConfig, options);
        }
    }

    /**
     * Initialize jobber (if not already done so in construction).
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
     *     properties: logger {Bunyan compatible logger}
     *
     * @returns {void}
     */

    public init(serverId:string, pgConfig:any, options?:any) {
        this.serverId = serverId;
        this.pgConfig = pgConfig;
        this.options  = options ? options : {};

        let _this = this;

        return new Promise(function(resolve, reject) {
            // Check whether jobs table exists, and if not, create it
            let db = pgp(_this.pgConfig);

            db.one("SELECT to_regclass('pgjobber_jobs')").then(results => {
                if (results.to_regclass !== null) {
                    // Already exists, so we're done
                    return Promise.resolve(false);
                }
                return _this.initDB(db);
            }).then( created => {
                if (created) { 
                    _this.logInfo("Jobs table (pgjobber_jobs) created"); 
                }
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
     * @returns {Promise.<Object,Object>} A promise that's resolved to the job 
     *     instructions and results objects.
     */

    public request(jobType:string, instr:any) {
        // Issue a new job request
        return new Promise( (resolve, reject) => {
            return Promise.resolve(5);
        });
    }

    /**
     * Handler callback
     *
     * @callback Jobber#handle#handlerCB(instr)
     *
     * @param   {Object} instr - Requested job instructions
     * @returns {Object} Job results
     */

    /**
     * Register a handler for a particular job type
     *
     * @method Jobber#handle
     * 
     * @param {string} jobType - String identifying the job type to be handled
     * @param {handlerCB} handlerCb
     *
     * @returns {void}
     */
    public handle(jobType:string, handlerCb:any) : void {
        // Register this server as a handler for this jobType
    }

    //
    // Private helper methods
    //

    private initDB(db:any) {
        let _this = this;

        return new Promise(function(resolve, reject) {
            db.any(jobTableDef).then( results => {
                let promList = [];
                let prom;
                for (let i = 0; i < jobIndexesDefs.length; i++) {
                    prom = db.any(jobIndexesDefs[i]);
                    promList.push(prom);
                }

                return Promise.all(promList);
            }).then( results => {
                resolve(true);
            }).catch( err => {
                _this.logError("pg-jobber unable to create database table", err);
                reject(err);
            });
        });
    }

    private logError(msg:string, err:any) {
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