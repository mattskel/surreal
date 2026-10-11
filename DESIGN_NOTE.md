# Design note: scaling to 10× and 100×

Startup replay breaks first, then in-memory storage, then write throughput. Correctness risks (sequence gaps, silent subscriber failures) grow with load alongside them.

## What breaks, in order

1. **Startup replay.** On start, every instance replays the whole log from the event base (`index.js:59`). As the event base grows, so does startup time. Deploys and crash recovery slow down with it.
2. **Read models in memory.** Read models are stored in in-memory maps. Every instance holds its own full copy, so memory grows with the log, not with traffic. Some queries scan everything: `getEarningsForEntertainer` filters every booking per request.
3. **Sequence gaps (if catch-up is used across instances).** Catch-up fetches events after the last handled number (`index.js:307`). A slower insert can become visible after later numbers, so it is skipped. "Last handled" is the most recently processed event, not the highest (`event-bus-nodejs.js:31`), so it can go backwards and reapply events.
4. **Write latency.** When an event is saved, the server runs every subscription for that event type before responding (`eventstore.js:104`). The client waits while they run, and in-memory subscriber work holds Node's single thread, so other requests queue behind it.
5. **One table, one counter.** All events go into a single `eventlist` table on one Postgres server. It only ever grows, every instance's writes funnel through it, and replay reads all of it.
6. **Silent subscriber failures.** A subscriber that errors after startup is only logged (`eventstore.js:110-119`), so read models can drift from the log without anyone knowing.

## At 10×: keep the architecture, make it cheaper

- **Snapshots.** Save read model state with its last sequence number (e.g. end of every day), then on startup only replay events after it (`startup(lastHandledSequenceNumber)`, `index.js:177`). Version snapshots and rebuild from zero when model logic changes.
- **Index read models.** Before a full database refactor, expand the in-memory maps so queries stop scanning every booking. For example, getting an entertainer’s earnings currently scans every booking.
- **Monitoring.** Track startup time, each instance's lag (latest sequence in the database vs last handled), and subscriber errors.

## At 100×: change the architecture

- **Read models get their own database.** Startup doesn't need replay. Instances become stateless and scale horizontally, all reading from the same copy.
- **One projector per read model.** A separate worker reads the event logs in order, is the only writer to its read model, stores its position with its updates, and retries from there on failure. Instances only write events and query the read db.
- **Writes return as soon as the event is saved.** Don't wait for subscriptions. Clients that need to read their own write wait for it using `X-Seq-Num` (`sequenceNumberMiddleware.js`). This stops clients reading before the read models have updated.
- **Read the log without gaps.** Only read events older than a short safety window, or wait for missing numbers before moving on. For example, if events 9 and 11 are visible but not 10, process 9 and stop until 10 arrives, or a short timeout passes. 
- **Partition and archive the event table.** Archive old events behind snapshots. If one Postgres can't keep up with writes, move to a dedicated log store, e.g. Kafka or EventStoreDB.
