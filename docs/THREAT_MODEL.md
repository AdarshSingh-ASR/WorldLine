# WORLDLINE threat model

## Safety boundary

WORLDLINE reserves strategic space-time 30–60 seconds ahead. It does not replace
onboard collision avoidance, navigation, geofencing, lost-link behavior, or
certified flight control.

## Principal risks and controls

| Risk | Control |
| --- | --- |
| Model invents an unsafe maneuver | The model ranks a closed candidate list; deterministic validation is authoritative. |
| Approximate vector result is physically inapplicable | Exact geometry, vehicle, battery, timing, and policy filters run after ANN retrieval. |
| Two agents reserve the same future | Serializable capacity mutation and unique exclusion-slot claims. |
| Transaction retry repeats an external action | Bedrock and S3 remain outside transactions; commands use an idempotent outbox. |
| Ambiguous commit result | Resolve by idempotency key and receipt lookup; never blindly replay. |
| CDC duplicates or cross-key reordering | Deduplicate by source key and MVCC timestamp; use resolved timestamps as progress watermarks. |
| Historical state expires | Retain short-term MVCC history deliberately and archive signed receipts to versioned S3. |
| Region becomes unavailable | Three-region database with region-survival goal and regional connection endpoints. |
| Database credential compromise | Separate migration, runtime, CDC, and audit identities with table-level grants. |
| Demo fallback mistaken for live state | UI labels deterministic mode; submission must display `MEMORY PLANE LIVE`. |

## Fail-closed behavior

Missing policy, stale policy version, unavailable current-state read, exhausted
retry budget, failed exact validation, or absent safe fallback all prevent a
movement token from entering the outbox.
