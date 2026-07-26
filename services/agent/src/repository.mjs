import { createHash, randomUUID } from "node:crypto";
import { TwoPartyBarrier, withSerializable } from "./database.mjs";
import {
  maneuvers,
  validateHlc,
  validateSafety,
  vectorLiteral,
} from "./invariants.mjs";

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
          ($1, $3, 'KESTREL-7', 'us-east-1', 'medium-cargo', 'planned', $4, $6, 'aws-us-east-1'),
          ($2, $3, 'ORBITAL-3', 'ap-south-1', 'medium-cargo', 'planned', $5, $7, 'aws-us-east-1')
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
                gen_random_uuid(), $1, $2, 1, 0.94, 1, true, 'aws-us-east-1'
              )
            `,
            [memoryId, decisionId],
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
        const evidence = { routeId, maneuver, safety, memoryId };
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

  async runRace({ maneuver, memory, embeddingProvider, plannerProvider }) {
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
          const capacity = await client.query(
            `
              SELECT capacity, used, revision
                FROM corridor_capacity
               WHERE scenario_id = $1 AND corridor_id = $2
            `,
            [scenario.id, corridorId],
          );
          if (capacity.rowCount !== 1) throw new Error("Corridor capacity missing");
          if (coordinate && attempt === 0) await barrier.wait();
          if (coordinate && recalled && attempt === 0) await winnerCommitted;

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
          const decisionHlc = await client.query(
            "SELECT cluster_logical_timestamp()::STRING AS hlc",
          );
          await client.query(
            `
              INSERT INTO route_decisions (
                id, scenario_id, route_request_id, agent_id, home_region,
                corridor_id, state, selected_memory_id, maneuver_id,
                maneuver, safety_result, retry_count, decision_hlc, crdb_region
              ) VALUES ($1, $2, $3, $4, $5, $6, 'committed', $7, $8, $9, $10, $11, $12, $13)
            `,
            [
              decisionId,
              scenario.id,
              routeId,
              agentId,
              agentId === "KESTREL-7" ? "us-east-1" : "ap-south-1",
              corridorId,
              useAlternate ? memory?.id ?? null : null,
              useAlternate ? maneuver.id : "ORIGINAL",
              useAlternate ? maneuver : { label: "Original worldline" },
              safety,
              baseRetryCount + attempt,
              decisionHlc.rows[0].hlc,
              "aws-us-east-1",
            ],
          );

          const cells = useAlternate
            ? ["X17-A-01", "X17-A-02", "X17-A-03", "X17-A-04"]
            : agentId === "KESTREL-7"
              ? ["X17-01", "X17-02", "X17-03", "X17-04"]
              : ["X17-03", "X17-04", "X17-05", "X17-06"];
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
                  0, $5, $6
                )
              `,
              [
                scenario.id,
                decisionId,
                cells[index],
                index,
                "us-east-1",
                "aws-us-east-1",
              ],
            );
          }

          if (useAlternate && memory) {
            await client.query(
              `
                INSERT INTO memory_reads (
                  id, memory_id, route_decision_id, rank, similarity,
                  causal_weight, exact_match, created_at, crdb_region
                ) VALUES (gen_random_uuid(), $1, $2, 1, $3, 1, true, now(), 'aws-us-east-1')
              `,
              [memory.id, decisionId, memory.similarity],
            );
          }

          await client.query(
            `
              INSERT INTO command_outbox (
                id, route_decision_id, command_type, payload, state, crdb_region
              ) VALUES ($1, $2, 'movement-token', $3, 'pending', $4)
            `,
            [
              commandId,
              decisionId,
              { agentId, corridorId, routeId },
              "aws-us-east-1",
            ],
          );
          const receiptEvidence = {
            agentId,
            corridorId,
            safety,
            useAlternate,
          };
          const contentHash = createHash("sha256")
            .update(JSON.stringify(receiptEvidence))
            .digest("hex");
          await client.query(
            `
              INSERT INTO commit_receipts (
                id, scenario_id, route_decision_id, memory_id, decision_hlc,
                evidence, content_hash, cdc_confirmed, crdb_region
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
            `,
            [
              receiptId,
              scenario.id,
              decisionId,
              useAlternate ? memory?.id ?? null : null,
              decisionHlc.rows[0].hlc,
              receiptEvidence,
              contentHash,
              "aws-us-east-1",
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
            decisionHlc: decisionHlc.rows[0].hlc,
            useAlternate,
            safety,
          };
        },
        { priority, maxAttempts: coordinate && recalled ? 1 : 5 },
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
      memoryAge: "6 weeks ago",
      maneuver: maneuver.label,
      retryCount: recalledResult.retryCount,
      cdcConfirmed,
      mode: "live",
      routes: [routeAResult.value, routeBResult.value],
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
      memoryAge: "not recalled",
      maneuver: maneuver.label,
      retryCount: 0,
      cdcConfirmed: false,
      mode: "live",
      rejected: true,
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
