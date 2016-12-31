export var jobTableDef = `
    CREATE TABLE pgjobber_jobs (
        job_id    INTEGER PRIMARY KEY,

        requester VARCHAR(64) NOT NULL, -- ids requesters channel, notified when done
        job_type  VARCHAR(64) NOT NULL, -- ids worker channel notified for new jobs
        priority  INTEGER DEFAULT 5,    -- 0-10, higher numbers have higher priority

        instrs    JSONB   NOT NULL,     -- job instructions
        results   JSONB,                -- job results

        job_state INTEGER NOT NULL,     -- 0 pending, 1 in process, 2 completed
        worker    VARCHAR(64),          -- worker ID, for server-restart job recovery
        failures  INTEGER DEFAULT 0,    -- number of times job processing failed

        requested TIMESTAMP,            -- when requested
        started   TIMESTAMP,            -- when job was started by a worker
        completed TIMESTAMP             -- when work completed
    );
`;

export var jobIndexesDefs = [
    "CREATE INDEX job_type_idx  ON pgjobber_jobs (job_type);",
    "CREATE INDEX requester_idx ON pgjobber_jobs (requester);",
    "CREATE INDEX priority_idx  ON pgjobber_jobs (priority);",
    "CREATE INDEX state_idx     ON pgjobber_jobs (job_state);"
];

export var GetAllJobs = `
    SELECT * FROM pgjobber_jobs;
`;
