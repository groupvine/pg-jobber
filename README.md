# PostreSQL-based Job Manager (pg-jobber)

A simple, responsive job queue manager based on PostgreSQL 9.6+,
designed for clusters of up to about 5-10 workers per job type.

* Simple, promise-based API for job requesters and handler interface
  for workers.

* Flexible, JSON-based job request instructions and results.

* Takes advantage of "SKIP LOCKED" and "LISTEN/NOTIFY" features of
  Postgres 9.6 for robust and responsive performance.

* Supports differing job priorities, reporting individual job
  progress, and tracking job processing performance per job type.

Note that this module will create a "pg_jobber_jobs" table in the associated 
PostgreSQL database, if not already present.

## Example Usage

### Job Requester

```
var myId     = "server-10.0.0.17";
var pgconfig = {host : '10.0.0.11', port : 5432, database : 'mydb', 
                user : 'postgres', password : 'password'};

var jobber   = require('pg-jobber')(myId, pgconfig);

jobber.request("calculator", [5, '+', [2, '*', 3]]).then(instr, results => {
    console.info(`5 + (2 x 3) = ${results}`);
}).catch(err) {
    console.error("Calculator job request failed with error:", err);
});
```

### Job Worker

```
var myId     = "server-10.0.0.42";
var pgconfig = {host : '10.0.0.11', port : 5432, database : 'mydb', 
                user : 'postgres', password : 'password'};

var jobber   = require('pg-jobber')(myId, pgconfig);

jobber.handle('calculator', instr => {

    function calculate(num1:any, op:string, num2:any) {
        if (Array.isArray(num1)) { num1 = calculate(num1); }
        if (Array.isArray(num2)) { num2 = calculate(num2); }

        if (typeof num1 !== 'number' || typeof num2 !== 'number' || !op.match(/[\+\-\*\/]/)) {
            throw `Invalid operation: ${num1} ${op} ${num2}`
        }

        return eval(num1 + op + num2);
    }

    return calculate(instr);
});
```





