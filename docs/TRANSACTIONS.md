# Transaction design

## Admission invariant

A movement token may exist only when the same transaction has:

1. Read the active safety-policy version.
2. Consumed corridor capacity.
3. Inserted every rolling-horizon exclusion claim.
4. Stored the route decision and its memory dependency.
5. Stored deterministic safety results.
6. Created a commit receipt.
7. Appended the command to the idempotent outbox.

## Retry protocol

- Use `SERIALIZABLE`, the CockroachDB default.
- Model and embedding calls complete before `BEGIN`.
- Handle SQLSTATE `40001` with a bounded retry loop and jitter.
- A retry re-reads capacity and may select the already-prepared alternative.
- Treat SQLSTATE `40003` as ambiguous and resolve from the request idempotency
  key.
- Never perform S3, model, or actuator calls inside the transaction.

## Historical reconstruction

After commit, read `crdb_internal_mvcc_timestamp` from the receipt row. The API
accepts only a numeric HLC grammar before placing it in the literal-only
`AS OF SYSTEM TIME` clause.

## Changefeed contract

The CDC projection is not a source of truth. CockroachDB remains authoritative.
The consumer expects at-least-once delivery and per-key ordering only. It stores
`(source_table, source_key, mvcc_timestamp)` before broadcasting an event and
reconnects from the largest recorded timestamp.
