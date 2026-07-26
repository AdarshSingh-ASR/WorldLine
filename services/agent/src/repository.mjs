import { randomUUID } from "node:crypto";
import { TwoPartyBarrier, withSerializable } from "./database.mjs";
import {
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
    const result = await this.pool.query(`
      SELECT
        now() AS checked_at,
        version() AS version,
        current_database() AS database_name
    `);
    return result.rows[0];
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
    await this.pool.query(
      `
        BEGIN;
        DELETE FROM occupancy_claims WHERE scenario_id = $1;
        DELETE FROM route_decisions WHERE scenario_id = $1;
        DELETE FROM route_requests WHERE scenario_id = $1;
        UPDATE corridor_capacity
           SET used = 0, revision = revision + 1, updated_at = now()
         WHERE scenario_id = $1;
        COMMIT;
      `,
      [scenario.id],
    );
    return { scenarioId: scenario.id, reset: true };
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
          status, idempotency_key, input
        ) VALUES
          ($1, $3, 'KESTREL-7', 'us-east-1', 'medium-cargo', 'planned', $4, $6),
          ($2, $3, 'ORBITAL-3', 'ap-south-1', 'medium-cargo', 'planned', $5, $7)
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

  async runRace({ maneuver, memory, embeddingProvider, plannerProvider }) {
    await this.resetDemo();
    const { routeA, routeB } = await this.prepareRequests({
      maneuver,
      memory,
      embeddingProvider,
      plannerProvider,
    });
    const barrier = new TwoPartyBarrier();

    const commit = async ({ routeId, agentId, priority, recalled }) =>
      withSerializable(
        this.pool,
        async (client, attempt) => {
          const useAlternate = recalled && attempt > 0;
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
          if (attempt === 0) await barrier.wait();

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
            minimumSeparationM: useAlternate ? 0 : agentId === "KESTREL-7" ? 38 : 0,
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
                maneuver, safety_result, retry_count, decision_hlc
              ) VALUES ($1, $2, $3, $4, $5, $6, 'committed', $7, $8, $9, $10, $11, $12)
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
              attempt,
              decisionHlc.rows[0].hlc,
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
                  slot_end, exclusion_slot, home_region
                ) VALUES (
                  gen_random_uuid(), $1, $2, $3,
                  now() + ($4 * interval '5 seconds'),
                  now() + (($4 + 1) * interval '5 seconds'),
                  0, $5
                )
              `,
              [
                scenario.id,
                decisionId,
                cells[index],
                index,
                agentId === "KESTREL-7" ? "us-east-1" : "ap-south-1",
              ],
            );
          }

          if (useAlternate && memory) {
            await client.query(
              `
                INSERT INTO memory_reads (
                  id, memory_id, route_decision_id, rank, similarity,
                  causal_weight, exact_match, created_at
                ) VALUES (gen_random_uuid(), $1, $2, 1, $3, 1, true, now())
              `,
              [memory.id, decisionId, memory.similarity],
            );
          }

          await client.query(
            `
              INSERT INTO command_outbox (
                id, route_decision_id, command_type, payload, state
              ) VALUES ($1, $2, 'movement-token', $3, 'pending')
            `,
            [commandId, decisionId, { agentId, corridorId, routeId }],
          );
          await client.query(
            `
              INSERT INTO commit_receipts (
                id, scenario_id, route_decision_id, memory_id, decision_hlc,
                evidence, content_hash, cdc_confirmed
              ) VALUES ($1, $2, $3, $4, $5, $6, encode(sha256($7::BYTES), 'hex'), false)
            `,
            [
              receiptId,
              scenario.id,
              decisionId,
              useAlternate ? memory?.id ?? null : null,
              decisionHlc.rows[0].hlc,
              { agentId, corridorId, safety, useAlternate },
              JSON.stringify({ agentId, corridorId, safety, useAlternate }),
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
        { priority, maxAttempts: 5 },
      );

    const [routeAResult, routeBResult] = await Promise.all([
      commit({
        routeId: routeA,
        agentId: "KESTREL-7",
        priority: "HIGH",
        recalled: false,
      }),
      commit({
        routeId: routeB,
        agentId: "ORBITAL-3",
        priority: "LOW",
        recalled: true,
      }),
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

    return {
      runId: `WL-${String(Date.now()).slice(-4)}`,
      receiptId: recalledResult.value.receiptId,
      decisionHlc: mvcc.rows[0]?.hlc ?? recalledResult.value.decisionHlc,
      similarity: Math.round(Number(memory?.similarity ?? 0) * 100),
      memoryId: memory?.id ?? "NO-MEMORY",
      memoryAge: "6 weeks ago",
      maneuver: maneuver.label,
      retryCount: recalledResult.retryCount,
      cdcConfirmed: false,
      mode: "live",
      routes: [routeAResult.value, routeBResult.value],
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
         ORDER BY created_at
      `);
      return { asOf: hlc, routes: result.rows };
    }
    const result = await this.pool.query(
      `
        SELECT id, scenario_id, agent_id, corridor_id, state, selected_memory_id,
               maneuver, safety_result, decision_hlc, created_at
          FROM route_decisions
         WHERE scenario_id = $1
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
    return result.rows[0] ?? null;
  }
}

export { scenario };
