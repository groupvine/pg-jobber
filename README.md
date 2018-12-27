# Postres-based Job Manager (pg-jobber)

A simple, responsive job queue manager based on PostgreSQL 9.5+,
designed for clusters of up to about a dozen job servers per job type.

* Simple, promise-based API for job requesters and handler interface
  for workers.

* Flexible, JSON-based job request instructions and results.

* Takes advantage of "SKIP LOCKED" and "LISTEN/NOTIFY" features of
  Postgres 9.5 for robust and responsive performance.

* Supports an arbitrary number of job types and job server pools,
  specified number of concurrent worker threads for each job server,
  specified maximum number of attempts per job of each type,
  differing job priorities, and tracking of job processing
  performance.

**Note that this module will create a "pgjobber_jobs" table in the referenced
PostgreSQL database, if not already present.**

### Installation

Using npm, in your project directory:

```
npm install --save davebeyer/pg-jobber
```

## Example Usage

### Initialize jobber

To be done once during server startup initialization 
(same for job requesters and servers).

```
// Specify unique id for each server
var myId     = "server-10.0.0.17";

// Specify connection to your PostgreSQL database
var pgp      = require('pg-promise')();
var db       = pgp({host : '10.0.0.11', port : 5432, 
                    database : 'mydb', 
                    user : 'postgres', password : 'password'});

// Initialize pg-jobber
var jobber   = require('pg-jobber')(myId, db);
```


### UpperCaser Example 

#### Worker

Registering for the uppercaser job type and processing jobs:

```
jobber.handle('uppercaser', (instrs) => { return instrs.toUpperCase(); })
```

#### Requester

Issuing an uppercaser job request:

```
jobber.request("uppercaser", "hello").then(response => {
    console.info(`hello -> ${response.results}`);
}).catch(err => {
    console.error("Uppercaser job request failed with error:", err);
});
```


### Calculator Example

#### Worker

Registering for the calculator job type and processing jobs:

```

function calculator(instrs) {
    function calculate(num1:any, op:string, num2:any) {
        if (Array.isArray(num1)) { num1 = calculate.apply(this, num1); }
        if (Array.isArray(num2)) { num2 = calculate.apply(this, num2); }

        if (typeof num1 !== 'number' || typeof num2 !== 'number' || !op.match(/[\+\-\*\/]/)) {
            throw `Invalid operation: ${num1} ${op} ${num2}`
        }

        return eval(num1 + op + num2);
    }

    return calculate.apply(this, instrs);
}

// Allow two simultaneous workers
jobber.handle('calculator', calculator, {maxWorkers : 2});
```

#### Requester

Issuing a calculator job request:

```
jobber.request("calculator", [5, '+', [2, '*', 3]]).then(response => {
    console.info(`5 + (2 x 3) = ${response.results}`);
}).catch(err => {
    console.error("Calculator job request failed with error:", err);
});
```
<a name="Jobber"></a>

## Jobber
**Kind**: global class  

* [Jobber](#Jobber)
    * [new Jobber([serverId], [pg], [options])](#new_Jobber_new)
    * [.init(serverId, pg, [options])](#Jobber+init) ⇒ <code>void</code>
    * [.request(jobType, instr, [options])](#Jobber+request) ⇒ <code>Promise.&lt;Object&gt;</code>
    * [.handle(jobType, handlerCb, [options])](#Jobber+handle) ⇒ <code>void</code>
        * [.handlerCB(instrs,](#Jobber+handle+handlerCB(instrs,) ⇒ <code>any</code> &#124; <code>Promise</code>
    * [.workerPool()](#Jobber+workerPool) ⇒ <code>null</code> &#124; <code>string</code>

<a name="new_Jobber_new"></a>

### new Jobber([serverId], [pg], [options])
A Postgres-based job scheduling utility
for small- to medium-sized server clusters.

Constructor, optionally invoked with serverId and
Postgres configuration data (otherwise, must call .init()
with this info).


| Param | Type |
| --- | --- |
| [serverId] | <code>string</code> | 
| [pg] | <code>Object</code> | 
| [options] | <code>Object</code> | 

<a name="Jobber+init"></a>

### jobber.init(serverId, pg, [options]) ⇒ <code>void</code>
Initialize jobber (if not already done in construction).

**Kind**: instance method of <code>[Jobber](#Jobber)</code>  

| Param | Type | Description |
| --- | --- | --- |
| serverId | <code>string</code> | Unique string identifying this server |
| pg | <code>Object</code> | pg-promise database connection object. |
| [options] | <code>Object</code> | Optional configuration info, with     properties: 'logger' {Bunyan compatible logger};     'archiveJobs' {boolean} to archive rather than delete jobs     from queue when done; 'maxWorkers' {integer} for the default     maximum number of simultaneous worker processes per job type (defaults to 1);     'maxAttempts' {number} for the default maximum number of times to     attempt jobs when encountering processing errors (defaults to 3);     'workerPool' {string} to allow separating job workers into different     pools (still using same database), e.g., for administrator use,     test servers, or a high-volume customer; 'errorHandler(msg, err?)' {function}     callback function for errors getting passed an error msg and possibly an     Error object. |

<a name="Jobber+request"></a>

### jobber.request(jobType, instr, [options]) ⇒ <code>Promise.&lt;Object&gt;</code>
Request a new job

**Kind**: instance method of <code>[Jobber](#Jobber)</code>  
**Returns**: <code>Promise.&lt;Object&gt;</code> - A promise that resolves with an object
    with 'results', original 'instrs', 'jobType', and 'priority' properties  

| Param | Type | Description |
| --- | --- | --- |
| jobType | <code>string</code> | String identifying the job type and associated worker pool |
| instr | <code>Object</code> | Job-specific instructions |
| [options] | <code>Object</code> | Has optional properties: 'priority' {number}       for integer job priority (priority 1 has most urgency, default 5). |

<a name="Jobber+handle"></a>

### jobber.handle(jobType, handlerCb, [options]) ⇒ <code>void</code>
Register a handler for a particular job type

**Kind**: instance method of <code>[Jobber](#Jobber)</code>  

| Param | Type | Description |
| --- | --- | --- |
| jobType | <code>string</code> | String identifying the job type to be handled |
| handlerCb | <code>handlerCB</code> | Callback to job handler function |
| [options] | <code>Object</code> | Optional properties are: 'maxWorkers' {number}     for the maximum number of simultaneous workers for this job type on     this server; 'maxAttempts' {number} for maximum number of times to     attempt jobs of this type when encountering processing errors. |

<a name="Jobber+handle+handlerCB(instrs,"></a>

#### handle.handlerCB(instrs, ⇒ <code>any</code> &#124; <code>Promise</code>
Handler callback

**Kind**: instance typedef of <code>[handle](#Jobber+handle)</code>  
**Returns**: <code>any</code> &#124; <code>Promise</code> - The worker's response object or a Promise to the
         response, with the job results in the 'results' property.
         (If the job failed, then results.error contains an error object, with
          at least error.message.) Other properties are:
            'attempts' for the number of attempts required, and
            'instrs', 'jobType', and 'priority' with the job's original
             job type, instructions, and priority.  

| Param | Type | Description |
| --- | --- | --- |
| instrs | <code>Object</code> | Requested job instructions |
| jobInfo | <code>Object</code> | Job information data, including postgres 'job_id',                   'attempts', 'requester', and 'priority' |

<a name="Jobber+workerPool"></a>

### jobber.workerPool() ⇒ <code>null</code> &#124; <code>string</code>
Get the worker pool this Jobber is running in.  This
can be useful, for instance, by worker services
creating modified URIs
for content created to be returned to the user, so the user
remains connected to a given worker pool.

**Kind**: instance method of <code>[Jobber](#Jobber)</code>  
