var pgp = require('pg-promise')();

declare var Promise:any;

import {jobTableDef,
        jobIndexesDefs} from './db';

class Jobber {
    serverId : string;
    pgConfig : any;
    options  : any;

    constructor (serverId?:any, pgConfig?:any, options?:any) {
        if (serverId && pgConfig) {
            this.init(serverId, pgConfig, options);
        }
    }

    public init(serverId:string, pgConfig:any, options?:any) {
        this.serverId = serverId;
        this.pgConfig = pgConfig;
        this.options  = options ? options : {};

        let _this = this;

        return new Promise(function(resolve, reject) {
            // Check whether jobs table exists, and if not, create it
            let db = pgp(_this.pgConfig);

            db.one("SELECT to_regclass('pg_jobber_jobs')").then(results => {
                if (results.to_regclass !== null) {
                    // Already exists, so we're done
                    return Promise.resolve(false);
                }
                return _this.initDB(db);
            }).then( created => {
                if (created) { 
                    _this.logInfo("Jobs table (pg_jobber_jobs) created"); 
                }
                resolve();
            }).catch(err => {
                _this.logError("pg-jobber init failed", err);
                reject();
            });
        });
    }

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