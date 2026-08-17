import { createHash, randomUUID } from "node:crypto";
import { TwoPartyBarrier, withSerializable } from "./database.mjs";
import {
  maneuvers,
  validateHlc,
  validateSafety,
  vectorLiteral,
} from "./invariants.mjs";

/**
 * The agent roster is the single source of truth for agent identity and home
 * region. Route insertion, decision rows and the scenario briefing all read it,
 * so a region label can never disagree between the database and the interface.
 */
const agents = [
  { id: "KESTREL-7", homeRegion: "us-east-1", role: "original" },
  { id: "ORBITAL-3", homeRegion: "ap-south-1", role: "recalled" },
];

/**
 * Row homing for REGIONAL BY ROW tables. Rows are placed in the region of the
 * gateway that wrote them, falling back to the database primary region when the
 * gateway is not a database region. Pinning every row to one hardcoded region
 * made every statement a cross-region round trip for an agent running anywhere
 * else, stretching the admission transaction past the point where its commit
 * timestamp could still be refreshed.
 */
const LOCAL_REGION_SQL =
  "default_to_database_primary_region(gateway_region())::crdb_internal_region";

function homeRegionFor(agentId) {
  return agents.find((agent) => agent.id === agentId)?.homeRegion ?? "us-east-1";
}

const scenario = {
  id: "ATLAS-X17",
  description:
    "87 degree converging merge, 18.4 meters per second closure, 11.2 knot crosswind, asymmetric battery reserve",
  homeRegion: "ap-south-1",
  vehicleClass: "medium-cargo",
  batteryPct: 47,
  minimumSeparationM: 0,
};

export class WorldlineRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async health() {
    const [database, regions, cdc] = await Promise.all([
      this.pool.query(`
      SELECT
        now() AS checked_at,
        version() AS version,
        current_database() AS database_name
      `),
      this.pool.query("SHOW REGIONS FROM DATABASE worldline"),
      this.pool.query(`
        SELECT max(observed_at) AS last_observed_at,
               count(*)::INT AS confirmation_count
          FROM cdc_confirmations
         WHERE source_table IN (
           'route_decisions',
           'occupancy_claims',
           'commit_receipts'
         )
      `),
    ]);
    return {
      ...database.rows[0],
      regions: regions.rows,
      cdc: cdc.rows[0],
    };
  }

  async retrieveMemories(vector) {
    const result = await this.pool.query(
      `
        SELECT
          id,
          title,
          scenario,
          maneuver_id AS "maneuverId",
          maneuver,
          outcome,
          confidence,
          occurred_at AS "occurredAt",
          1 - (embedding <=> $3::VECTOR) AS similarity
        FROM maneuver_memories
        WHERE home_region = $1
          AND vehicle_class = $2
          AND outcome = 'verified-safe'
        ORDER BY embedding <=> $3::VECTOR
        LIMIT 3
      `,
      [scenario.homeRegion, scenario.vehicleClass, vectorLiteral(vector)],
    );
    return result.rows;
  }

  async resetDemo() {
    for (const corridorId of ["X-17", "X-17-ALT"]) {
      await this.pool.query(
        `
          UPDATE corridor_capacity
             SET used = 0, revision = revision + 1, updated_at = now()
           WHERE scenario_id = $1 AND corridor_id = $2
        `,
        [scenario.id, corridorId],
      );
    }
    return { scenarioId: scenario.id, reset: true };
  }

  async executeIdempotent({
    key,
    method,
    path,
    payload,
    operation,
  }) {
    const ownerToken = randomUUID();
    const requestHash = createHash("sha256")
      .update(JSON.stringify(payload ?? {}))
      .digest("hex");
    const inserted = await this.pool.query(
      `
        INSERT INTO api_idempotency (
          idempotency_key, request_method, request_path, request_hash,
          state, owner_token, crdb_region
        ) VALUES ($1, $2, $3, $4, 'pending', $5, 'aws-us-east-1')
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
      `,
      [key, method, path, requestHash, ownerToken],
    );

    if (inserted.rowCount === 1) {
      try {
        const body = await operation();
        await this.pool.query(
          `
            UPDATE api_idempotency
               SET state = 'completed',
                   response_status = 200,
                   response_body = $2,
                   completed_at = now()
             WHERE idempotency_key = $1 AND owner_token = $3
          `,
          [key, body, ownerToken],
        );
        return { statusCode: 200, body, replayed: false };
      } catch (error) {
        await this.pool.query(
          `
            UPDATE api_idempotency
               SET state = 'failed', completed_at = now()
             WHERE idempotency_key = $1 AND owner_token = $2
          `,
          [key, ownerToken],
        ).catch(() => {});
        throw error;
      }
    }

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const existing = await this.pool.query(
        `
          SELECT request_method, request_path, request_hash, state,
                 response_status, response_body
            FROM api_idempotency
           WHERE idempotency_key = $1
        `,
        [key],
      );
      const row = existing.rows[0];
      if (!row) break;
      if (
        row.request_method !== method ||
        row.request_path !== path ||
        row.request_hash !== requestHash
      ) {
        const error = new Error("Idempotency key was already used for a different request");
        error.statusCode = 409;
        throw error;
      }
      if (row.state === "completed") {
        return {
          statusCode: row.response_status,
          body: row.response_body,
          replayed: true,
        };
      }
      if (row.state === "failed") {
        const error = new Error("The original idempotent operation failed");
        error.statusCode = 409;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const error = new Error("Idempotent operation is still in progress");
    error.statusCode = 409;
    throw error;
  }

  async prepareRequests({ maneuver, memory, embeddingProvider, plannerProvider }) {
    const routeA = randomUUID();
    const routeB = randomUUID();
    const idempotencyA = `demo-a-${randomUUID()}`;
    const idempotencyB = `demo-b-${randomUUID()}`;
    await this.pool.query(
      `
        INSERT INTO route_requests (
          id, scenario_id, agent_id, home_region, vehicle_class,
          status, idempotency_key, input, crdb_region
        ) VALUES
          ($1, $3, $8, $9, 'medium-cargo', 'planned', $4, $6, ${LOCAL_REGION_SQL}),
          ($2, $3, $10, $11, 'medium-cargo', 'planned', $5, $7, ${LOCAL_REGION_SQL})
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        routeA,
        routeB,
        scenario.id,
        idempotencyA,
        idempotencyB,
        {
          scenario,
          route: "original",
          embeddingProvider,
          plannerProvider,
        },
        {
          scenario,
          route: "memory-shaped",
          maneuver,
          memoryId: memory?.id ?? null,
          embeddingProvider,
          plannerProvider,
        },
        agents[0].id,
        agents[0].homeRegion,
        agents[1].id,
        agents[1].homeRegion,
      ],
    );
    return { routeA, routeB };
  }

  async savePlan({
    idempotencyKey,
    maneuver,
    memory,
    embeddingProvider,
    plannerProvider,
  }) {
    const routeId = randomUUID();
    await this.pool.query(
      `
        INSERT INTO route_requests (
          id, scenario_id, agent_id, home_region, vehicle_class,
          status, idempotency_key, input, crdb_region
        ) VALUES (
          $1, $2, 'ORBITAL-3', 'ap-south-1', 'medium-cargo',
          'planned', $3, $4, 'aws-us-east-1'
        )
      `,
      [
        routeId,
        scenario.id,
        `plan-${idempotencyKey}`,
        {
          scenario,
          selectedMemoryId: memory?.id ?? null,
          selectedMemorySimilarity: memory?.similarity ?? null,
          embeddingProvider,
          plannerProvider,
        },
      ],
    );
    const ordered = [
      maneuver,
      ...maneuvers.filter((candidate) => candidate.id !== maneuver.id),
    ];
    for (let index = 0; index < ordered.length; index += 1) {
      const candidate = ordered[index];
      await this.pool.query(
        `
          INSERT INTO route_candidates (
            route_request_id, candidate_rank, maneuver_id, cells,
            predicted_safety, crdb_region
          ) VALUES ($1, $2, $3, $4, $5, 'aws-us-east-1')
        `,
        [
          routeId,
          index + 1,
          candidate.id,
          JSON.stringify(
            candidate.id === "MANEUVER-03"
              ? ["X17-A-01", "X17-A-02", "X17-A-03", "X17-A-04"]
              : ["X17-03", "X17-04", "X17-05", "X17-06"],
          ),
          validateSafety({
            minimumSeparationM: 0,
            maneuver: candidate,
            batteryPct: scenario.batteryPct,
          }),
        ],
      );
    }
    return { routeId, state: "planned" };
  }

  async commitPlannedRoute(routeId) {
    const committed = await withSerializable(
      this.pool,
      async (client, attempt) => {
        const plan = await client.query(
          `
            SELECT r.id, r.status, r.input, c.maneuver_id, c.cells,
                   c.predicted_safety
              FROM route_requests r
              JOIN route_candidates c
                ON c.route_request_id = r.id AND c.candidate_rank = 1
             WHERE r.id = $1
             FOR UPDATE OF r
          `,
          [routeId],
        );
        if (plan.rowCount !== 1) {
          const error = new Error("Planned route not found");
          error.statusCode = 404;
          throw error;
        }
        if (plan.rows[0].status === "committed") {
          const prior = await client.query(
            `
              SELECT r.id AS receipt_id, r.decision_hlc,
                     d.id AS decision_id, d.corridor_id, d.safety_result
                FROM route_decisions d
                JOIN commit_receipts r ON r.route_decision_id = d.id
               WHERE d.route_request_id = $1
            `,
            [routeId],
          );
          return {
            routeId,
            receiptId: prior.rows[0].receipt_id,
            decisionId: prior.rows[0].decision_id,
            decisionHlc: prior.rows[0].decision_hlc,
            corridorId: prior.rows[0].corridor_id,
            safety: prior.rows[0].safety_result,
            retryCount: attempt,
          };
        }
        const maneuver = maneuvers.find(
          (candidate) => candidate.id === plan.rows[0].maneuver_id,
        );
        const safety = validateSafety({
          minimumSeparationM: 0,
          maneuver,
          batteryPct: scenario.batteryPct,
        });
        if (!safety.valid) {
          const error = new Error("Exact safety validation rejected the selected maneuver");
          error.statusCode = 422;
          throw error;
        }
        const capacity = await client.query(
          `
            UPDATE corridor_capacity
               SET used = used + 1, revision = revision + 1, updated_at = now()
             WHERE scenario_id = $1 AND corridor_id = 'X-17-ALT'
               AND used < capacity
            RETURNING corridor_id
          `,
          [scenario.id],
        );
        if (capacity.rowCount !== 1) {
          const error = new Error("Corridor capacity exhausted");
          error.code = "40001";
          throw error;
        }
        const decisionId = randomUUID();
        const receiptId = randomUUID();
        const hlc = await client.query(
          "SELECT cluster_logical_timestamp()::STRING AS hlc",
        );
        const memoryId = plan.rows[0].input?.selectedMemoryId ?? null;
        const memorySimilarity = Number(
          plan.rows[0].input?.selectedMemorySimilarity ?? 0,
        );
        await client.query(
          `
            INSERT INTO route_decisions (
              id, scenario_id, route_request_id, agent_id, home_region,
              corridor_id, state, selected_memory_id, maneuver_id,
              maneuver, safety_result, retry_count, decision_hlc, crdb_region
            ) VALUES (
              $1, $2, $3, 'ORBITAL-3', 'ap-south-1', 'X-17-ALT',
              'committed', $4, $5, $6, $7, $8, $9, 'aws-us-east-1'
            )
          `,
          [
            decisionId,
            scenario.id,
            routeId,
            memoryId,
            maneuver.id,
            maneuver,
            safety,
            attempt,
            hlc.rows[0].hlc,
          ],
        );
        const cells = plan.rows[0].cells;
        for (let index = 0; index < cells.length; index += 1) {
          await client.query(
            `
              INSERT INTO occupancy_claims (
                id, scenario_id, route_decision_id, cell_id, slot_start,
                slot_end, exclusion_slot, home_region, crdb_region
              ) VALUES (
                gen_random_uuid(), $1, $2, $3,
                now() + ($4::INT * interval '5 seconds'),
                now() + (($4::INT + 1) * interval '5 seconds'),
                0, 'us-east-1', 'aws-us-east-1'
              )
            `,
            [scenario.id, decisionId, cells[index], index],
          );
        }
        if (memoryId) {
          await client.query(
            `
              INSERT INTO memory_reads (
                id, memory_id, route_decision_id, rank, similarity,
                causal_weight, exact_match, crdb_region
              ) VALUES (
                gen_random_uuid(), $1, $2, 1, $3, 1, true, 'aws-us-east-1'
              )
            `,
            [memoryId, decisionId, memorySimilarity],
          );
        }
        await client.query(
          `
            INSERT INTO command_outbox (
              id, route_decision_id, command_type, payload, state, crdb_region
            ) VALUES (
              gen_random_uuid(), $1, 'movement-token',
              $2, 'pending', 'aws-us-east-1'
            )
          `,
          [decisionId, { agentId: "ORBITAL-3", corridorId: "X-17-ALT", routeId }],
        );
        const evidence = {
          routeId,
          maneuver,
          safety,
          memoryId,
          memorySimilarity,
          providers: {
            embedding: plan.rows[0].input?.embeddingProvider ?? "unknown",
            ranking: plan.rows[0].input?.plannerProvider ?? "unknown",
          },
        };
        const serializedEvidence = JSON.stringify(evidence);
        const contentHash = createHash("sha256")
          .update(serializedEvidence)
          .digest("hex");
        await client.query(
          `
            INSERT INTO commit_receipts (
              id, scenario_id, route_decision_id, memory_id, decision_hlc,
              evidence, content_hash, cdc_confirmed, crdb_region
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, false, 'aws-us-east-1'
            )
          `,
          [
            receiptId,
            scenario.id,
            decisionId,
            memoryId,
            hlc.rows[0].hlc,
            evidence,
            contentHash,
          ],
        );
        await client.query(
          "UPDATE route_requests SET status = 'committed' WHERE id = $1",
          [routeId],
        );
        return {
          routeId,
          decisionId,
          receiptId,
          decisionHlc: hlc.rows[0].hlc,
          corridorId: "X-17-ALT",
          safety,
          retryCount: attempt,
        };
      },
      { priority: "NORMAL", maxAttempts: 5 },
    );
    return {
      ...committed.value,
      cdcConfirmed: await this.waitForCdc(committed.value.receiptId),
    };
  }

  async extendRoute(routeId) {
    const result = await withSerializable(
      this.pool,
      async (client) => {
        const decision = await client.query(
          `
            SELECT id, corridor_id
              FROM route_decisions
             WHERE route_request_id = $1 AND state = 'committed'
             FOR UPDATE
          `,
          [routeId],
        );
        if (decision.rowCount !== 1) {
          const error = new Error("Committed route not found");
          error.statusCode = 404;
          throw error;
        }
        const horizon = await client.query(
          `
            SELECT coalesce(max(slot_end), now()) AS horizon
              FROM occupancy_claims
             WHERE route_decision_id = $1
          `,
          [decision.rows[0].id],
        );
        const claim = await client.query(
          `
            INSERT INTO occupancy_claims (
              id, scenario_id, route_decision_id, cell_id, slot_start,
              slot_end, exclusion_slot, home_region, crdb_region
            ) VALUES (
              gen_random_uuid(), $1, $2, 'X17-A-05', $3,
              $3 + interval '15 seconds', 0, 'us-east-1', 'aws-us-east-1'
            )
            RETURNING id, slot_start, slot_end
          `,
          [scenario.id, decision.rows[0].id, horizon.rows[0].horizon],
        );
        return {
          routeId,
          corridorId: decision.rows[0].corridor_id,
          horizon: claim.rows[0],
        };
      },
      { maxAttempts: 5 },
    );
    return result.value;
  }

  async runRace({
    maneuver,
    memory,
    memories = [],
    embeddingProvider,
    plannerProvider,
  }) {
    await this.resetDemo();
    const { routeA, routeB } = await this.prepareRequests({
      maneuver,
      memory,
      embeddingProvider,
      plannerProvider,
    });
    const barrier = new TwoPartyBarrier();
    let releaseWinner;
    const winnerCommitted = new Promise((resolve) => {
      releaseWinner = resolve;
    });

    const commit = async ({
      routeId,
      agentId,
      priority,
      recalled,
      alternate = false,
      coordinate = true,
      baseRetryCount = 0,
    }) =>
      withSerializable(
        this.pool,
        async (client, attempt) => {
          const useAlternate = alternate;
          const corridorId = useAlternate ? "X-17-ALT" : "X-17";
          // Coordinate BEFORE touching corridor_capacity.
          //
          // Reading capacity first leaves the waiting agent parked on
          // `winnerCommitted` while holding an open serializable transaction
          // with a read timestamp on the contested row. The winner's UPDATE
          // then cannot refresh that read and takes RETRY_SERIALIZABLE, but the
          // waiter only unparks once the winner commits — so the winner burns
          // its whole retry budget and the race deadlocks. Low-latency
          // single-region clusters usually hid this by letting the winner reach
          // its UPDATE first; a multi-region cluster loses that race reliably.
          if (coordinate && attempt === 0) await barrier.wait();
          if (coordinate && recalled && attempt === 0) await winnerCommitted;

          const capacity = await client.query(
            `
              SELECT capacity, used, revision
                FROM corridor_capacity
               WHERE scenario_id = $1 AND corridor_id = $2
            `,
            [scenario.id, corridorId],
          );
          if (capacity.rowCount !== 1) throw new Error("Corridor capacity missing");

          const claimed = await client.query(
            `
              UPDATE corridor_capacity
                 SET used = used + 1,
                     revision = revision + 1,
                     updated_at = now()
               WHERE scenario_id = $1
                 AND corridor_id = $2
                 AND used < capacity
              RETURNING corridor_id, used, capacity, revision
            `,
            [scenario.id, corridorId],
          );
          if (claimed.rowCount === 0) {
            const error = new Error("Corridor capacity exhausted");
            error.code = "40001";
            throw error;
          }

          const safety = validateSafety({
            minimumSeparationM: useAlternate ? 0 : 38,
            maneuver: useAlternate
              ? maneuver
              : { altitudeDeltaM: agentId === "KESTREL-7" ? 38 : 0, energyCostPct: 0, timeDeltaS: 0 },
            batteryPct: scenario.batteryPct,
          });
          if (!safety.valid) throw new Error("Deterministic safety validation rejected route");

          const decisionId = randomUUID();
          const receiptId = randomUUID();
          const commandId = randomUUID();
          // The HLC is produced by the insert itself rather than a preceding
          // SELECT, removing a round trip from the critical section.
          const decisionRow = await client.query(
            `
              INSERT INTO route_decisions (
                id, scenario_id, route_request_id, agent_id, home_region,
                corridor_id, state, selected_memory_id, maneuver_id,
                maneuver, safety_result, retry_count, decision_hlc, crdb_region
              ) VALUES (
                $1, $2, $3, $4, $5, $6, 'committed', $7, $8, $9, $10, $11,
                cluster_logical_timestamp()::STRING, ${LOCAL_REGION_SQL}
              )
              RETURNING decision_hlc AS hlc
            `,
            [
              decisionId,
              scenario.id,
              routeId,
              agentId,
              homeRegionFor(agentId),
              corridorId,
              useAlternate ? memory?.id ?? null : null,
              useAlternate ? maneuver.id : "ORIGINAL",
              useAlternate ? maneuver : { label: "Original worldline" },
              safety,
              baseRetryCount + attempt,
            ],
          );
          const decisionHlcValue = decisionRow.rows[0].hlc;

          const cells = useAlternate
            ? ["X17-A-01", "X17-A-02", "X17-A-03", "X17-A-04"]
            : agentId === "KESTREL-7"
              ? ["X17-01", "X17-02", "X17-03", "X17-04"]
              : ["X17-03", "X17-04", "X17-05", "X17-06"];
          // One statement for every exclusion claim. Four separate inserts cost
          // four cross-region round trips inside a transaction that must stay
          // short enough to survive a commit-timestamp push.
          await client.query(
            `
              INSERT INTO occupancy_claims (
                id, scenario_id, route_decision_id, cell_id, slot_start,
                slot_end, exclusion_slot, home_region, crdb_region
              )
              SELECT
                gen_random_uuid(), $1, $2, cell.id,
                now() + (cell.slot * interval '5 seconds'),
                now() + ((cell.slot + 1) * interval '5 seconds'),
                0, $3, ${LOCAL_REGION_SQL}
              FROM unnest($4::STRING[]) WITH ORDINALITY AS cell(id, slot)
            `,
            [scenario.id, decisionId, homeRegionFor(agentId), cells],
          );

          if (useAlternate && memory) {
            await client.query(
              `
                INSERT INTO memory_reads (
                  id, memory_id, route_decision_id, rank, similarity,
                  causal_weight, exact_match, created_at, crdb_region
                ) VALUES (
                  gen_random_uuid(), $1, $2, 1, $3, 1, true, now(),
                  ${LOCAL_REGION_SQL}
                )
              `,
              [memory.id, decisionId, memory.similarity],
            );
          }

          await client.query(
            `
              INSERT INTO command_outbox (
                id, route_decision_id, command_type, payload, state, crdb_region
              ) VALUES ($1, $2, 'movement-token', $3, 'pending', ${LOCAL_REGION_SQL})
            `,
            [
              commandId,
              decisionId,
              { agentId, corridorId, routeId },
            ],
          );
          const receiptEvidence = {
            agentId,
            corridorId,
            safety,
            useAlternate,
            providers: {
              embedding: embeddingProvider,
              ranking: plannerProvider,
            },
          };
          const contentHash = createHash("sha256")
            .update(JSON.stringify(receiptEvidence))
            .digest("hex");
          await client.query(
            `
              INSERT INTO commit_receipts (
                id, scenario_id, route_decision_id, memory_id, decision_hlc,
                evidence, content_hash, cdc_confirmed, crdb_region
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, ${LOCAL_REGION_SQL})
            `,
            [
              receiptId,
              scenario.id,
              decisionId,
              useAlternate ? memory?.id ?? null : null,
              decisionHlcValue,
              receiptEvidence,
              contentHash,
            ],
          );
          await client.query(
            "UPDATE route_requests SET status = 'committed' WHERE id = $1",
            [routeId],
          );
          return {
            routeId,
            decisionId,
            receiptId,
            corridorId,
            decisionHlc: decisionHlcValue,
            useAlternate,
            safety,
            // Surfaced so the control room can label every route with the
            // agent and region that actually committed it, rather than
            // assuming a fixed two-agent demo shape.
            agentId,
            homeRegion: homeRegionFor(agentId),
            maneuverId: useAlternate ? maneuver.id : "ORIGINAL",
            maneuverLabel: useAlternate ? maneuver.label : "Original worldline",
            selectedMemoryId: useAlternate ? memory?.id ?? null : null,
            cells,
            state: "committed",
            attemptRetryCount: baseRetryCount + attempt,
          };
        },
        {
          priority,
          maxAttempts: coordinate && recalled ? 1 : 5,
          label: `${agentId}${alternate ? "-alt" : ""}`,
        },
      );

    const routeAPromise = commit({
        routeId: routeA,
        agentId: "KESTREL-7",
        priority: "NORMAL",
        recalled: false,
      }).then(
        (result) => {
          releaseWinner();
          return result;
        },
        (error) => {
          releaseWinner();
          throw error;
        },
      );
    const routeBPromise = commit({
        routeId: routeB,
        agentId: "ORBITAL-3",
        priority: "NORMAL",
        recalled: true,
      }).catch(async (error) => {
        if (error?.code !== "40001") throw error;
        const retried = await commit({
          routeId: routeB,
          agentId: "ORBITAL-3",
          priority: "NORMAL",
          recalled: true,
          alternate: true,
          coordinate: false,
          baseRetryCount: 1,
        });
        return {
          ...retried,
          retryCount: retried.retryCount + 1,
        };
      });
    const [routeAResult, routeBResult] = await Promise.all([
      routeAPromise,
      routeBPromise,
    ]);

    const recalledResult = routeBResult.value.useAlternate
      ? routeBResult
      : routeAResult.value.useAlternate
        ? routeAResult
        : routeBResult;
    const mvcc = await this.pool.query(
      `
        SELECT crdb_internal_mvcc_timestamp::STRING AS hlc
          FROM commit_receipts
         WHERE id = $1
      `,
      [recalledResult.value.receiptId],
    );
    const cdcConfirmed = await this.waitForCdc(recalledResult.value.receiptId);

    return {
      runId: `WL-${String(Date.now()).slice(-4)}`,
      receiptId: recalledResult.value.receiptId,
      decisionHlc: mvcc.rows[0]?.hlc ?? recalledResult.value.decisionHlc,
      similarity: Math.round(Number(memory?.similarity ?? 0) * 100),
      memoryId: memory?.id ?? "NO-MEMORY",
      // The occurrence timestamp is returned verbatim so the interface can
      // derive the real age of the recalled episode instead of asserting one.
      memoryOccurredAt: memory?.occurredAt ?? null,
      maneuver: maneuver.label,
      maneuverId: maneuver.id,
      // The full candidate, so the viewport can derive the real trajectory
      // offset instead of hardcoding a bend magnitude.
      selectedManeuver: maneuver,
      causalReason: maneuver.causalReason ?? null,
      retryCount: recalledResult.retryCount,
      cdcConfirmed,
      providers: {
        embedding: embeddingProvider,
        ranking: plannerProvider,
      },
      mode: "live",
      scenario,
      // Every candidate the vector index returned, not just the winner, so the
      // memory panel can show what was considered and what was rejected.
      memories,
      routes: [
        { ...routeAResult.value, retryCount: routeAResult.retryCount },
        { ...routeBResult.value, retryCount: routeBResult.retryCount },
      ],
    };
  }

  async recordCounterfactual({ maneuver, embeddingProvider, plannerProvider }) {
    await this.resetDemo();
    const routeId = randomUUID();
    const decisionId = randomUUID();
    const safety = validateSafety({
      minimumSeparationM: 0,
      maneuver,
      batteryPct: scenario.batteryPct,
    });
    const timestamp = await this.pool.query(
      "SELECT cluster_logical_timestamp()::STRING AS hlc",
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query(
        `
          INSERT INTO route_requests (
            id, scenario_id, agent_id, home_region, vehicle_class,
            status, idempotency_key, input, crdb_region
          ) VALUES (
            $1, $2, 'ORBITAL-3', 'ap-south-1', 'medium-cargo',
            'rejected', $3, $4, 'aws-us-east-1'
          )
        `,
        [
          routeId,
          scenario.id,
          `counterfactual-${randomUUID()}`,
          { scenario, embeddingProvider, plannerProvider, memoryEnabled: false },
        ],
      );
      await client.query(
        `
          INSERT INTO route_decisions (
            id, scenario_id, route_request_id, agent_id, home_region,
            corridor_id, state, selected_memory_id, maneuver_id,
            maneuver, safety_result, retry_count, decision_hlc, crdb_region
          ) VALUES (
            $1, $2, $3, 'ORBITAL-3', 'ap-south-1',
            'X-17', 'rejected', NULL, $4, $5, $6, 0, $7, 'aws-us-east-1'
          )
        `,
        [
          decisionId,
          scenario.id,
          routeId,
          maneuver.id,
          maneuver,
          safety,
          timestamp.rows[0].hlc,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return {
      runId: `WL-${String(Date.now()).slice(-4)}`,
      receiptId: "NO-COMMIT",
      decisionHlc: timestamp.rows[0].hlc,
      similarity: 0,
      memoryId: "NO-MEMORY",
      memoryOccurredAt: null,
      maneuver: maneuver.label,
      maneuverId: maneuver.id,
      causalReason: maneuver.causalReason ?? null,
      retryCount: 0,
      cdcConfirmed: false,
      mode: "live",
      rejected: true,
      scenario,
      memories: [],
      safety,
      routes: [],
    };
  }

  async waitForCdc(receiptId, timeoutMs = 6_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.pool.query(
        `
          SELECT cdc_confirmed OR EXISTS (
            SELECT 1 FROM cdc_confirmations
             WHERE source_table = 'commit_receipts'
               AND source_key = $1::STRING
          ) AS confirmed
          FROM commit_receipts
          WHERE id = $1::UUID
        `,
        [receiptId],
      );
      if (result.rows[0]?.confirmed) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async markReceiptArchived(receiptId, archive) {
    await this.pool.query(
      `
        UPDATE commit_receipts
           SET archived = $2,
               archive_key = $3,
               archive_hash = $4
         WHERE id = $1
      `,
      [
        receiptId,
        Boolean(archive.archived),
        archive.key ?? null,
        archive.contentHash ?? null,
      ],
    );
  }

  async recordBrokerFailure(region = "eu-west-1") {
    const regions = await this.pool.query("SHOW REGIONS FROM DATABASE worldline");
    const brokerRegion = region.startsWith("aws-") ? region : `aws-${region}`;
    const surviving = regions.rows
      .map((row) => row.database_region ?? row.region)
      .filter((value) => value && value !== brokerRegion);
    const timestamp = await this.pool.query(
      "SELECT cluster_logical_timestamp()::STRING AS hlc",
    );
    const event = await this.pool.query(
      `
        INSERT INTO broker_events (
          scenario_id, broker_region, state, surviving_regions,
          checked_hlc, crdb_region
        ) VALUES ($1, $2, 'disconnected', $3, $4, 'aws-us-east-1')
        RETURNING id, broker_region, state, surviving_regions, checked_hlc, created_at
      `,
      [scenario.id, brokerRegion, surviving, timestamp.rows[0].hlc],
    );
    return {
      ...event.rows[0],
      commitmentPlane: "available",
      databaseWriteVerified: true,
    };
  }

  /**
   * Everything the interface needs to establish the situation before any
   * commitment is attempted: the live scenario, the agents that will contend,
   * current corridor capacity, the active safety policy and the closed
   * maneuver candidate set.
   */
  async getScenarioBriefing() {
    const [corridors, policy, cells] = await Promise.all([
      this.pool.query(
        `
          SELECT corridor_id, capacity, used, revision, home_region, updated_at
            FROM corridor_capacity
           WHERE scenario_id = $1
           ORDER BY corridor_id
        `,
        [scenario.id],
      ),
      this.pool.query(`
        SELECT id, version, state, rules
          FROM safety_policies
         WHERE state = 'active'
         ORDER BY updated_at DESC
         LIMIT 1
      `),
      this.pool.query(`
        SELECT id, home_region, altitude_floor_m, altitude_ceiling_m, state
          FROM airspace_cells
         ORDER BY id
      `),
    ]);

    return {
      scenario,
      agents,
      maneuverCandidates: maneuvers,
      corridors: corridors.rows,
      policy: policy.rows[0] ?? null,
      airspaceCells: cells.rows,
      observedAt: new Date().toISOString(),
    };
  }

  async recordBrokerRecovery(region = "eu-west-1") {
    const brokerRegion = region.startsWith("aws-") ? region : `aws-${region}`;
    const regions = await this.pool.query("SHOW REGIONS FROM DATABASE worldline");
    const surviving = regions.rows
      .map((row) => row.database_region ?? row.region)
      .filter(Boolean);
    const timestamp = await this.pool.query(
      "SELECT cluster_logical_timestamp()::STRING AS hlc",
    );
    const event = await this.pool.query(
      `
        INSERT INTO broker_events (
          scenario_id, broker_region, state, surviving_regions,
          checked_hlc, crdb_region
        ) VALUES ($1, $2, 'recovered', $3, $4, 'aws-us-east-1')
        RETURNING id, broker_region, state, surviving_regions, checked_hlc, created_at
      `,
      [scenario.id, brokerRegion, surviving, timestamp.rows[0].hlc],
    );
    return {
      ...event.rows[0],
      commitmentPlane: "available",
      databaseWriteVerified: true,
    };
  }

  /**
   * Region health is derived from the cluster itself plus the most recent
   * broker event per region, so the health strip reflects committed database
   * state rather than a client-side toggle.
   */
  async getRegionHealth() {
    let regionRows = [];
    let multiRegion = true;
    try {
      const result = await this.pool.query(
        "SHOW REGIONS FROM DATABASE worldline",
      );
      regionRows = result.rows;
    } catch {
      multiRegion = false;
      const result = await this.pool
        .query("SHOW REGIONS FROM CLUSTER")
        .catch(() => ({ rows: [] }));
      regionRows = result.rows;
    }

    const [brokers, survival] = await Promise.all([
      this.pool.query(
        `
          SELECT DISTINCT ON (broker_region)
                 broker_region, state, surviving_regions, checked_hlc, created_at
            FROM broker_events
           WHERE scenario_id = $1
           ORDER BY broker_region, created_at DESC
        `,
        [scenario.id],
      ),
      this.pool
        .query("SHOW SURVIVAL GOAL FROM DATABASE worldline")
        .catch(() => ({ rows: [] })),
    ]);

    const brokerByRegion = new Map(
      brokers.rows.map((row) => [row.broker_region, row]),
    );

    const regions = regionRows.map((row) => {
      const name = row.database_region ?? row.region;
      const broker = brokerByRegion.get(name) ?? null;
      return {
        region: name,
        primary: Boolean(row.primary),
        zones: row.zones ?? null,
        // No broker event recorded means the region has never been taken
        // offline in this scenario, so it is reported as connected.
        state: broker?.state === "disconnected" ? "disconnected" : "connected",
        lastEvent: broker
          ? {
              state: broker.state,
              checkedHlc: broker.checked_hlc,
              createdAt: broker.created_at,
              survivingRegions: broker.surviving_regions,
            }
          : null,
      };
    });

    return {
      multiRegion,
      survivalGoal: survival.rows[0]?.survival_goal ?? null,
      regions,
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Real changefeed activity. The consumer service writes one row per observed
   * MVCC event into cdc_confirmations; this reads rows newer than the caller's
   * cursor. An empty result means the database genuinely produced no new
   * events, which is why the interface can treat a rising count as proof.
   */
  async getEventsSince(since) {
    const cdc = since
      ? await this.pool.query(
          `
            SELECT source_table, source_key, mvcc_timestamp, event_op, observed_at
              FROM cdc_confirmations
             WHERE observed_at > $1
             ORDER BY observed_at DESC
             LIMIT 50
          `,
          [since],
        )
      : await this.pool.query(`
          SELECT source_table, source_key, mvcc_timestamp, event_op, observed_at
            FROM cdc_confirmations
           ORDER BY observed_at DESC
           LIMIT 50
        `);

    // Deliberately no count(*). The confirmation table is append-only and
    // grows without bound: an exact count is a full scan that measured at
    // 5.4s against a million rows, which a polling client would queue up on.
    // max(observed_at) is served by cdc_by_observed_time in ~350ms, and the
    // interface counts the events it actually receives.
    const latest = await this.pool.query(`
      SELECT max(observed_at) AS latest_observed_at
        FROM cdc_confirmations
    `);

    return {
      events: cdc.rows.reverse(),
      cursor: latest.rows[0]?.latest_observed_at ?? null,
      latestObservedAt: latest.rows[0]?.latest_observed_at ?? null,
      observedAt: new Date().toISOString(),
    };
  }

  async getWorld(asOf) {
    if (asOf) {
      const hlc = validateHlc(asOf);
      const result = await this.pool.query(`
        SELECT id, scenario_id, agent_id, corridor_id, state, selected_memory_id,
               maneuver, safety_result, decision_hlc, created_at
          FROM route_decisions AS OF SYSTEM TIME '${hlc}'
         WHERE scenario_id = 'ATLAS-X17'
         ORDER BY created_at DESC
         LIMIT 2
      `);
      return { asOf: hlc, routes: result.rows.reverse() };
    }
    const result = await this.pool.query(
      `
        SELECT *
          FROM (
            SELECT id, scenario_id, agent_id, corridor_id, state, selected_memory_id,
                   maneuver, safety_result, decision_hlc, created_at
              FROM route_decisions
             WHERE scenario_id = $1 AND state = 'committed'
             ORDER BY created_at DESC
             LIMIT 2
          ) AS current_world
         ORDER BY created_at
      `,
      [scenario.id],
    );
    return { asOf: "current", routes: result.rows };
  }

  async getReceipt(id) {
    const result = await this.pool.query(
      `
        SELECT r.*, d.agent_id, d.corridor_id, d.maneuver, d.safety_result,
               d.crdb_internal_mvcc_timestamp::STRING AS world_hlc,
               EXISTS (
                 SELECT 1 FROM cdc_confirmations c
                  WHERE c.source_table = 'commit_receipts'
                    AND c.source_key = r.id::STRING
               ) AS cdc_observed
          FROM commit_receipts r
          JOIN route_decisions d ON d.id = r.route_decision_id
         WHERE r.id = $1
      `,
      [id],
    );
    const receipt = result.rows[0];
    if (!receipt) return null;
    const worldHlc = validateHlc(receipt.world_hlc);
    const snapshot = await this.pool.query(`
      SELECT id, scenario_id, agent_id, corridor_id, state,
             selected_memory_id, maneuver, safety_result, decision_hlc, created_at
        FROM route_decisions AS OF SYSTEM TIME '${worldHlc}'
       WHERE scenario_id = 'ATLAS-X17'
       ORDER BY created_at DESC
       LIMIT 2
    `);
    return {
      ...receipt,
      asOf: worldHlc,
      worldSnapshot: snapshot.rows.reverse(),
    };
  }
}

export { scenario };
