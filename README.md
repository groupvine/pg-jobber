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


## Example Usage

### Job Requester

```
var myId    = "server-10.0.0.17";
var pgsql   = {adr : 10.0.0.11, port : 5432};

var jobber  = require('pg-jobber')(myId, pgsql);

jobber.request("calculator", ['add', 5, ['multiply', 2, 3]]).then(instr, results => {
    console.info(`5 + (2 x 3) = ${results}`);
}).catch(err) {
    console.error("Calculator job request failed with error:", err);
});
```

### Job Worker

```
var myId    = "server-10.0.0.42";
var pgsql   = {adr : 10.0.0.11, port : 5432};

var jobber  = require('pg-jobber')(myId, pgsql);

jobber.handle('calculator', instr => {

    function calculate(operation:string, operand1:any, operand2:any) {
        if (Array.isArray(operand1)) { operand1 = calculate(operand1); }
        if (Array.isArray(operand2)) { operand2 = calculate(operand2); }

        switch(operation) {
        case 'multiply':
            return operand1 * operand2;
        case 'divide':
            return operand1 / operand2;
        case 'add':
            return operand1 + operand2;
        case 'subtract':
            return operand1 - operand2;
        }
    }

    return calculate(instr);
});
```





