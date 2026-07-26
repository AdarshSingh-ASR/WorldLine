---
name: designing-worldline-transactions
description: Keep WORLDLINE admissions short, serializable, idempotent, and retry-safe.
---

# WORLDLINE transaction skill

- Complete model, embedding, and S3 operations outside the transaction.
- Send all reservation mutations as one short serializable unit.
- Handle `40001` with bounded retries and jitter.
- Resolve `40003` through the idempotency journal.
- Never issue a movement token unless capacity, cells, decision, receipt, and
  outbox commit together.
