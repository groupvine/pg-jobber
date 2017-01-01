# Postres-based Job Manager (pg-jobber)

A simple, responsive job queue manager based on PostgreSQL 9.6+,
designed for clusters of up to about a dozen workers per job type.

* Simple, promise-based API for job requesters and handler interface
  for workers.

* Flexible, JSON-based job request instructions and results.

* Takes advantage of "SKIP LOCKED" and "LISTEN/NOTIFY" features of
  Postgres 9.6 for robust and responsive performance.

* Supports an arbitrary number of job types and worker pools,  differing 
  job priorities, and tracking of job processing performance.

**Note that this module will create a "pgjobber_jobs" table in the associated 
PostgreSQL database, if not already present.**

## Example Usage

### Initialize jobber

To be done once during server startup initialization 
(same for job requesters and workers).

```
var myId     = "server-10.0.0.17";
var pgconfig = {host : '10.0.0.11', port : 5432, database : 'mydb', 
                user : 'postgres', password : 'password'};

var jobber   = require('pg-jobber')(myId, pgconfig);
```


### Requester

Issuing a job request:

```
jobber.request("calculator", [5, '+', [2, '*', 3]]).then(response => {
    console.info(`5 + (2 x 3) = ${response.results}`);
}).catch(err) {
    console.error("Calculator job request failed with error:", err);
});
```

### Worker

Registering for a job type and processing jobs:

```
jobber.handle('calculator', instrs => {

    function calculate(num1:any, op:string, num2:any) {
        if (Array.isArray(num1)) { num1 = calculate(num1); }
        if (Array.isArray(num2)) { num2 = calculate(num2); }

        if (typeof num1 !== 'number' || typeof num2 !== 'number' || !op.match(/[\+\-\*\/]/)) {
            throw `Invalid operation: ${num1} ${op} ${num2}`
        }

        return eval(num1 + op + num2);
    }

    return calculate(instrs);
});
```
<a name="Jobber"></a>

## Jobber
**Kind**: global class  

* [Jobber](#Jobber)
    * [new Jobber([serverId], [pgConfig], [options])](#new_Jobber_new)
    * [.init(serverId, pgConfig, [options])](#Jobber+init) ⇒ <code>void</code>
    * [.request(jobType, instr)](#Jobber+request) ⇒ <code>Promise.&lt;Object&gt;</code>
    * [.handle(jobType, handlerCb)](#Jobber+handle) ⇒ <code>void</code>
        * [.handlerCB](#Jobber+handle+handlerCB(instrs)) ⇒ <code>Object</code>

<a name="new_Jobber_new"></a>

### new Jobber([serverId], [pgConfig], [options])
A Postgres-based job scheduling utility
for relatively small server clusters.

Constructor, optionally invoked with serverId and
Postgres configuration data (otherwise, must call .init()
with this info).


| Param | Type |
| --- | --- |
| [serverId] | <code>string</code> | 
| [pgConfig] | <code>Object</code> | 
| [options] | <code>Object</code> | 

<a name="Jobber+init"></a>

### jobber.init(serverId, pgConfig, [options]) ⇒ <code>void</code>
Initialize jobber (if not already done so in construction).

**Kind**: instance method of <code>[Jobber](#Jobber)</code>  

| Param | Type | Description |
| --- | --- | --- |
| serverId | <code>string</code> | Unique string identifying this server |
| pgConfig | <code>Object</code> | Postgres configuration, must include     properties: host {string}, port {number}, database {string},     user {string}, and password {string}. |
| [options] | <code>Object</code> | Optional configuration info, with     properties: logger {Bunyan compatible logger};     archiveJobs {boolean} to archive rather than delete jobs     from queue when done. |

<a name="Jobber+request"></a>

### jobber.request(jobType, instr) ⇒ <code>Promise.&lt;Object&gt;</code>
Request a new job

**Kind**: instance method of <code>[Jobber](#Jobber)</code>  
**Returns**: <code>Promise.&lt;Object&gt;</code> - A promise that resolves with an object
    with 'results' and original 'instrs'  

| Param | Type | Description |
| --- | --- | --- |
| jobType | <code>string</code> | String identifying the job type and associated worker pool |
| instr | <code>Object</code> | Job-specific instructions |

<a name="Jobber+handle"></a>

### jobber.handle(jobType, handlerCb) ⇒ <code>void</code>
Register a handler for a particular job type

**Kind**: instance method of <code>[Jobber](#Jobber)</code>  

| Param | Type | Description |
| --- | --- | --- |
| jobType | <code>string</code> | String identifying the job type to be handled |
| handlerCb | <code>handlerCB</code> | Callback to job handler function |

<a name="Jobber+handle+handlerCB(instrs)"></a>

#### handle.handlerCB ⇒ <code>Object</code>
Handler callback

**Kind**: instance typedef of <code>[handle](#Jobber+handle)</code>  
**Returns**: <code>Object</code> - Job results or a Promise for results  

| Param | Type | Description |
| --- | --- | --- |
| instrs | <code>Object</code> | Requested job instructions |

