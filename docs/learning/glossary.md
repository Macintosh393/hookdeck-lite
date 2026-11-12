# Glossary

One line each. The link goes to the place the term is explained.

## Webhooks and delivery

| Term | Definition |
|---|---|
| [Webhook](webhooks-101.md#what-a-webhook-is) | An HTTP `POST` a provider sends to your URL to tell you something happened. |
| Provider | The system that sends a webhook. |
| Receiver | The system that accepts a webhook. |
| [Fast ACK](webhooks-101.md#fast-ack) | Storing a webhook and answering `2xx` immediately, doing the real work later. |
| [`202 Accepted`](webhooks-101.md#fast-ack) | "I have taken responsibility for this; processing is not finished." |
| [At-least-once](webhooks-101.md#delivery-guarantees) | Every message is delivered one or more times; duplicates are possible, loss is not. |
| [At-most-once](webhooks-101.md#delivery-guarantees) | Every message is delivered zero or one times; loss is possible. |
| [Exactly-once](webhooks-101.md#delivery-guarantees) | Unachievable across a network; approximated by at-least-once plus idempotent processing. |
| [Idempotency](webhooks-101.md#idempotency) | Doing an operation twice has the same effect as doing it once. |
| [Idempotency key](webhooks-101.md#idempotency) | A unique id carried by a message so the receiver can recognise repeats. |
| [Deduplication](webhooks-101.md#idempotency) | Recognising and discarding a repeated message, usually with a unique constraint on its id. |
| [Standard Webhooks](webhooks-101.md#standard-webhooks) | An open specification for webhook headers and signatures (`webhook-id`, `webhook-timestamp`, `webhook-signature`). |
| [`webhook-id`](webhooks-101.md#standard-webhooks) | The message's unique id, identical across retries; the idempotency key. |
| [Fan-out](../ARCHITECTURE.md#2-fan-out-and-filter-evaluation) | Turning one event into one delivery per matching connection. |
| [Replay](../adr/0007-dead-letter-and-replay.md) | Sending an already-processed event again, as a new delivery linked to the original. |

## Signatures and cryptography

| Term | Definition |
|---|---|
| [HMAC](webhooks-101.md#signatures) | A keyed hash that proves a message came from someone holding the secret and was not changed. |
| [Raw body](webhooks-101.md#raw-body) | The exact request bytes, before JSON parsing; the only thing a signature can be verified against. |
| [Replay attack](webhooks-101.md#replay-attacks) | Resending a captured, validly signed request. Stopped by a signed timestamp and deduplication. |
| [Timestamp tolerance](webhooks-101.md#replay-attacks) | How far a signed timestamp may differ from now before the request is rejected. |
| [Timing attack](webhooks-101.md#timing-safe-comparison) | Learning a secret from how long a comparison takes. |
| [Timing-safe comparison](webhooks-101.md#timing-safe-comparison) | A comparison that takes the same time whatever the inputs (`crypto.timingSafeEqual`). |
| [Encryption at rest](ssrf-and-network-security.md#encrypting-secrets-at-rest) | Storing data encrypted so a database leak alone does not reveal it. |
| [AES-256-GCM](ssrf-and-network-security.md#encrypting-secrets-at-rest) | Symmetric encryption that also detects tampering. |
| [Nonce / IV](ssrf-and-network-security.md#encrypting-secrets-at-rest) | A value that must be unique per encryption with a given key. |
| [Auth tag](ssrf-and-network-security.md#encrypting-secrets-at-rest) | GCM's integrity check; decryption fails without the right one. |
| [AAD](ssrf-and-network-security.md#encrypting-secrets-at-rest) | Context that is authenticated but not encrypted, binding a ciphertext to its owner. |
| [Key rotation](../SECURITY.md#key-rotation-documented-future-step-stretch-c5) | Replacing an encryption key and re-encrypting the data under the new one. |

## Queues and Redis

| Term | Definition |
|---|---|
| [Job queue](bullmq-101.md#why-a-queue-at-all) | A store of work items that one process adds and another processes later. |
| [BullMQ](bullmq-101.md#the-four-classes) | A Node.js job-queue library that keeps its state in Redis. |
| [Queue](bullmq-101.md#the-four-classes) | The BullMQ class used to add and inspect jobs. |
| [Worker](bullmq-101.md#the-four-classes) | The BullMQ class that fetches jobs and runs the processor. |
| [Processor](bullmq-101.md#the-four-classes) | The function a worker runs for each job. Returning completes the job; throwing fails it. |
| [Job](bullmq-101.md#job-lifecycle) | One unit of work with data, options, and a state. |
| [QueueEvents](bullmq-101.md#the-four-classes) | The BullMQ class for listening to a queue's events across all workers. |
| [Job ID](bullmq-101.md#job-ids) | A job's identifier. Adding a job with an existing id is ignored, which makes enqueueing idempotent. |
| [Attempts](bullmq-101.md#retries) | How many times a job may run before it is failed for good. |
| [Backoff strategy](bullmq-101.md#retries) | The function that decides how long to wait before a retry. |
| [`UnrecoverableError`](bullmq-101.md#retries) | A BullMQ error that fails a job immediately, skipping remaining attempts. |
| [Delayed job](bullmq-101.md#job-lifecycle) | A job parked until a timestamp, for example between retries. |
| [Lock](bullmq-101.md#stalled-jobs) | A worker's time-limited claim on an active job, renewed while it works. |
| [Stalled job](bullmq-101.md#stalled-jobs) | An active job whose lock expired because its worker died or blocked; it is run again. |
| [Concurrency](bullmq-101.md#concurrency) | How many jobs one worker processes at the same time. |
| [Graceful shutdown](bullmq-101.md#graceful-shutdown) | Stopping intake, finishing active jobs, then exiting. |
| [Lua script](bullmq-101.md#lua-scripts) | A program Redis runs atomically, used for read-decide-write logic. |
| [Atomicity](bullmq-101.md#lua-scripts) | A sequence of steps that happens entirely or not at all, with nothing interleaved. |
| [Pub/sub](bullmq-101.md#redis-pubsub) | Redis messaging in which published messages go to current subscribers and are not stored. |
| [`maxRetriesPerRequest: null`](bullmq-101.md#pitfalls) | The ioredis setting BullMQ workers need so blocking commands never give up. |
| [`noeviction`](bullmq-101.md#pitfalls) | The Redis memory policy that refuses writes when full instead of deleting keys. |
| [Sweeper](../QUEUES.md#sweeper) | The periodic task that re-enqueues work Postgres says is pending but Redis has no job for. |

## Reliability

| Term | Definition |
|---|---|
| [Exponential backoff](reliability-patterns.md#backoff-and-jitter) | Doubling the wait between retries. |
| [Jitter](reliability-patterns.md#jitter) | Randomness added to retry delays so clients do not retry in step. |
| [Full jitter](reliability-patterns.md#jitter) | A delay drawn uniformly between zero and the exponential ceiling. |
| [Thundering herd](reliability-patterns.md#the-thundering-herd) | Many clients retrying at the same instant and overloading a recovering service. |
| [`Retry-After`](reliability-patterns.md#retry-after) | A response header telling the client how long to wait before retrying. |
| [Classification](../QUEUES.md#response-classification) | Deciding whether a failure is retryable or permanent. |
| [Dead-letter queue (DLQ)](reliability-patterns.md#dead-letter-queues) | Where messages go when they cannot be processed, to be inspected and replayed. |
| [Poison message](reliability-patterns.md#dead-letter-queues) | A message that fails every time it is processed. |
| [Dual-write problem](reliability-patterns.md#the-outbox-pattern) | Two writes to two systems cannot be made atomic, so one can succeed while the other fails. |
| [Transactional outbox](reliability-patterns.md#the-outbox-pattern) | Writing the message to send into the database in the same transaction as the data, and publishing it afterwards. |
| [Outbox-lite](reliability-patterns.md#outbox-lite) | This project's variant: the Event row is the outbox record and a sweeper is the relay. |
| [Circuit breaker](reliability-patterns.md#circuit-breakers) | A guard that stops calling a failing dependency for a while. |
| [Backpressure](reliability-patterns.md#backpressure) | A slow stage making earlier stages slow down instead of letting work pile up. |
| [Rate limiting](reliability-patterns.md#rate-limiting-algorithms) | Capping how many requests a client may make in a period. |
| [Fixed window](reliability-patterns.md#rate-limiting-algorithms) | Counting requests per calendar window; allows bursts at the boundary. |
| [Sliding log](reliability-patterns.md#rate-limiting-algorithms) | Storing each request's timestamp; exact, with memory proportional to the rate. |
| [Sliding-window counter](reliability-patterns.md#rate-limiting-algorithms) | Estimating a sliding window from two fixed-window counters. |
| [Token bucket](reliability-patterns.md#rate-limiting-algorithms) | A limiter that allows bursts up to a bucket size while enforcing an average rate. |
| [Fail open / fail closed](../adr/0010-rate-limiting.md) | Whether a guard allows or refuses requests when it cannot make its check. |
| [Compare-and-set](../QUEUES.md#fan-out-processor) | An update that applies only if the current value is the expected one (`UPDATE … WHERE status = 'X'`). |
| [Liveness / readiness](../adr/0015-observability.md) | "Is the process stuck?" versus "can it serve traffic right now?" |
| [Server-Sent Events (SSE)](reliability-patterns.md#server-sent-events) | A long-lived HTTP response over which a server pushes text messages to a browser. |
| [Keep-alive (SSE)](reliability-patterns.md#keep-alive) | A periodic comment line that stops intermediaries from closing an idle stream. |
| [Cursor pagination](../DATA-MODEL.md#cursor-pagination) | Paging by "rows after this id" instead of by offset. |

## Network security

| Term | Definition |
|---|---|
| [SSRF](ssrf-and-network-security.md#what-ssrf-is) | Server-side request forgery: making a server send a request to a destination the attacker chose. |
| [Metadata endpoint](ssrf-and-network-security.md#the-cloud-metadata-endpoint) | `169.254.169.254`: a cloud service that hands instance credentials to anything on the machine. |
| [Link-local address](ssrf-and-network-security.md#the-cloud-metadata-endpoint) | An address valid only on the local network segment (`169.254.0.0/16`, `fe80::/10`). |
| [Private range](ssrf-and-network-security.md#encoding-tricks) | Addresses reserved for internal networks (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`). |
| [CGNAT](ssrf-and-network-security.md#encoding-tricks) | `100.64.0.0/10`, shared address space used behind carrier-grade NAT and by some internal networks. |
| [IPv4-mapped IPv6](ssrf-and-network-security.md#encoding-tricks) | An IPv4 address written inside an IPv6 address (`::ffff:127.0.0.1`). |
| [DNS rebinding](ssrf-and-network-security.md#dns-rebinding) | Answering DNS with a safe address for the check and an internal one for the connection. |
| [TOCTOU](ssrf-and-network-security.md#dns-rebinding) | Time-of-check to time-of-use: validating one thing and then using another. |
| [IP pinning](ssrf-and-network-security.md#ip-pinning) | Connecting to exactly the address that was validated, with no second DNS lookup. |
| [Egress filtering](ssrf-and-network-security.md#validate-at-connect-time) | Network rules restricting where a server may connect. |
| [STRIDE](../SECURITY.md#threat-model-stride-lite) | A checklist of threat categories: spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege. |
