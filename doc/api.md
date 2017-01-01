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

