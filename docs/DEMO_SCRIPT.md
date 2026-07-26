# WORLDLINE demo script — 2:20 target

## 0:00–0:20 — Shared memory of the physical future

“Autonomous machines make decisions independently, but they still occupy one
physical world. WORLDLINE gives them shared episodic memory and one globally
serializable future.”

Show the two cyan proposed worldlines and the future conflict at `T+14.2s`.

## 0:20–0:48 — Memory does cognitive work

Click **Commit both futures**.

“The memory plane embeds the live geometry. CockroachDB retrieves a verified near-miss
from six weeks ago: same merge angle, closing speed, crosswind, and battery
asymmetry. That memory records which maneuver actually worked.”

Point to `MEM-2041`, `94%`, and `Vertical separation / +38 m`.

## 0:48–1:20 — The unforgettable moment

“Both agents still attempt the original corridor. These are two real
serializable transactions.”

Route A commits. Route B displays `40001`. The dashed coral worldline continues
toward the collision while the lime route bends upward.

“The memory selected a pre-validated maneuver. Exact geometry and safety rules
approved it. CockroachDB then committed the route, exclusion cells, memory
dependency, receipt, and movement token atomically.”

## 1:20–1:43 — Independent consistency witness

Wait for the routes to turn solid green.

“This is not optimistic UI. A CockroachDB changefeed independently observed the
MVCC writes. The projection deduplicates at-least-once events and only then
marks the physical future authoritative.”

## 1:43–2:02 — Regional survival

The Europe broker disconnects.

“The application loses a region. The commitment plane remains available because
the database is configured to survive region failure. Regional operational
memory stays near its agents; global safety policy remains locally readable.”

## 2:02–2:20 — Receipt

Show the receipt.

“This receipt links the exact memory, selected maneuver, serializable retry,
MVCC timestamp, deterministic safety proof, CDC confirmation, and signed
movement token.”

End on:

> **The future has happened before. Remember it before machines move.**
