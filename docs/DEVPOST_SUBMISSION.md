# WORLDLINE — Devpost submission draft

## Inspiration

Autonomous systems do not only need memory of conversations. They need memory of
physical situations: which geometry nearly failed, which maneuver succeeded,
and whether that lesson is safe to apply now.

## What it does

WORLDLINE retrieves a verified prior near-miss, uses it to select a constrained
separation maneuver, validates that maneuver with exact rules, and atomically
reserves a collision-free future for multiple autonomous agents.

## How it was built

- CockroachDB distributed vector indexing stores structured episodic memory
  beside operational state.
- Serializable transactions commit corridor capacity, exclusion claims, the
  causal memory link, safety evidence, receipts, and movement tokens together.
- Multi-region table locality keeps operational memory near regional agents
  while global policy remains locally readable.
- MVCC and `AS OF SYSTEM TIME` reconstruct the exact world that caused a
  decision.
- Changefeeds independently confirm committed futures to the live interface.
- A provider boundary creates normalized 1024-dimensional scenario embeddings
  and ranks only a closed set of pre-validated maneuvers. The live credit
  deployment uses its deterministic fallback because AWS reports Bedrock model
  access as `NOT_AUTHORIZED`; Titan and Nova activate when the account is
  authorized without changing the decision contract.
- AWS Lambda is the typed decision boundary, ECS Fargate consumes CDC, API
  Gateway streams updates, and S3 stores versioned receipts.

## CockroachDB tools

- Distributed Vector Indexing is used at runtime for episodic recall.
- CockroachDB Agent Skills constrain transaction retries, privileges, and
  cluster-health verification.

## The key moment

Two agents claim intersecting futures. One serializable transaction wins. The
other agent recalls an 81.4%-similar near-miss, and its worldline visibly bends
above the collision. A dashed route preserves the no-memory counterfactual, so
the audience sees exactly what the memory changed.

## Production readiness

The model cannot authorize motion. Exact geometry, separation, battery,
capacity, policy, and idempotency checks remain deterministic. Onboard avoidance
remains authoritative. CDC handles duplicates, all external effects stay
outside transactions, and every accepted future receives a reproducible
receipt.
