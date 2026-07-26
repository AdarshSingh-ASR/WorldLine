---
name: reviewing-worldline-health
description: Verify topology, backups, vector indexing, CDC, and region survival before motion admission.
---

# WORLDLINE health skill

- Require all three configured regions to be available for the production demo.
- Verify the database survival goal, table localities, vector index, and
  changefeed status.
- Verify current backups before destructive schema work.
- Fail closed when the current authoritative world state cannot be read.
