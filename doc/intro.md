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
