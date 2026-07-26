---
name: hardening-worldline-privileges
description: Enforce least privilege across WORLDLINE database identities.
---

# WORLDLINE privilege skill

- Migration identity owns schema changes and is never available to runtime code.
- Runtime identity can read memories and policies and mutate route, receipt, and
  outbox tables only.
- CDC identity has `SELECT` and `CHANGEFEED` on its source tables plus writes to
  the confirmation table.
- Audit identity is read-only.
- Credentials are supplied by deployment secrets and never stored in source.
