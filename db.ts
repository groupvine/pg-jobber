// 
// Regarding TIMESTAMPS, as per suggestion here:
//   
//     http://stackoverflow.com/questions/32033114/javascript-postgres-timezone-and-timestamp-usage
//
//   All Timestamps are stored without timezones, and in UTC time.  So, 
//   for storing dates into the database, use: date.toUTCString(), and when
//   fetching dates from the database, use 'var dt = new Date(dbDateStr + ' UTC').
//
//   See Jobber class' db2Date() and date2Db() methods.

// import {JobState} from "./index";

export var jobTableTmpl = `
    CREATE TABLE pgjobber_jobs (
        job_id    SERIAL PRIMARY KEY,

        requester VARCHAR(64) NOT NULL, -- ids requesters channel, notified when done
        job_type  VARCHAR(64) NOT NULL, -- ids worker channel notified for new jobs
        priority  INTEGER DEFAULT 5,    -- 0-10, higher numbers have higher priority

        instrs    JSONB   NOT NULL,     -- job instructions
        results   JSONB,                -- job results

        job_state INTEGER NOT NULL,     -- 0 pending, 1 in process, 2 completed, 3 archived, 4 failed, 5 terminated
        worker    VARCHAR(64),          -- worker ID, for server-restart job recovery
        attempts  INTEGER DEFAULT 0,    -- number of times job processing has been attempted

        requested TIMESTAMP,            -- when requested
        started   TIMESTAMP,            -- when job was started by a worker
        completed TIMESTAMP             -- when work completed
    );
`;

export var jobIndexesTmpls = [
    // Index for job_id automatically created
    "CREATE INDEX job_type_idx  ON pgjobber_jobs (job_type);",
    "CREATE INDEX requester_idx ON pgjobber_jobs (requester);",
    "CREATE INDEX priority_idx  ON pgjobber_jobs (priority);",
    "CREATE INDEX state_idx     ON pgjobber_jobs (job_state);"
];

// JobState.New
export var newJobTmpl = "  \
    INSERT INTO pgjobber_jobs \
              (  requester, job_type, priority, instrs, job_state, requested) \
    VALUES    (${requester}, ${jobType}, ${priority}, ${instrs}::jsonb, 0, ${now})  \
    RETURNING job_id; \
";

export var sendNotifyTmpl = "       \
    NOTIFY ${channel~}, ${info}; \
";

export var regListenerTmpl = " \
    LISTEN ${channel~}; \
";

// Note that following assumes each worker is processing at most 1 job,
// otherwise, would need to be more specific with 
//          OR (job_state = 1 AND worker = ${serverId})) 
// "FOR UPDATE" ensures that the row is locked for the duration
// of the full transaction (including the outside update).
// "SKIP LOCKED" ensures that a server skips over any rows in the 
// process of being claimed by another worker.

// JobState.New -> JobState.Processing
export var claimJobTmpl = "            \
    UPDATE pgjobber_jobs               \
    SET    job_state = 1,              \
           started   = ${now},         \
           worker    = ${serverId},    \
           attempts  = attempts + 1    \
    FROM   (SELECT job_id as sel_job_id from pgjobber_jobs   \
             WHERE (job_state = 0              \
                    OR (job_state = 1 AND worker = ${serverId})) \
              AND  job_id <> ALL(${busyJobIds}) \
              AND  job_type = ${jobType}       \
              ORDER BY priority ASC, sel_job_id ASC  \
              FOR UPDATE SKIP LOCKED           \
              LIMIT 1) AS row                  \
    WHERE  job_id = row.sel_job_id             \
    RETURNING job_id, job_type, instrs, requester, attempts, priority, requested; \
";

export var getJobTmpl = "              \
   SELECT *                            \
     FROM pgjobber_jobs                \
    WHERE job_id = ${jobId}            \
";

// JobState.Completed
export var completeJobTmpl = "         \
    UPDATE pgjobber_jobs               \
    SET    job_state = 2,              \
           completed = ${now},         \
           results   = ${results}::jsonb  \
    WHERE  job_id = ${jobId};          \
";

export var removeJobTmpl = "           \
     DELETE FROM pgjobber_jobs         \
     WHERE  job_id = ${jobId};         \
";

// JobState.Archived
export var archiveJobTmpl = "           \
    UPDATE pgjobber_jobs               \
    SET    job_state = 3               \
    WHERE  job_id = ${jobId};          \
";

// JobState.Failed
export var failedJobTmpl = "           \
    UPDATE pgjobber_jobs               \
    SET    job_state = 4,              \
           completed = ${now},          \
           results   = ${results}::jsonb  \
    WHERE  job_id = ${jobId};          \
";

// JobState.Terminated
export var initCleanupTmpl = "           \
    UPDATE pgjobber_jobs                 \
    SET    job_state = 5,                \
           completed = ${now},           \
           results   = NULL              \
    WHERE  worker    = ${serverId} AND   \
           started   < ${startLimit} AND \
           completed IS NULL;            \
";
