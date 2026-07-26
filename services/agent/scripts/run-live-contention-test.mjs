import { randomUUID } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import pg from "pg";

const secrets = new SecretsManagerClient({
  region: process.env.WORLDLINE_AWS_REGION ?? "us-east-1",
});
const secret = await secrets.send(
  new GetSecretValueCommand({
    SecretId: process.env.WORLDLINE_DATABASE_SECRET_ID ?? "worldline/database",
  }),
);
const databaseUrl = JSON.parse(secret.SecretString).runtimeDatabaseUrl;
const pool = new pg.Pool({
  connectionString: databaseUrl,
  application_name: "worldline-live-contention-test",
  max: 25,
});
const scenarioId = `CONTENTION-${randomUUID()}`;
const routeId = randomUUID();
const decisionId = randomUUID();
const cellId = `CELL-${randomUUID()}`;

try {
  const slot = await pool.query(
    "SELECT now() + interval '30 minutes' AS slot_start",
  );
  const slotStart = slot.rows[0].slot_start;
  await pool.query(
    `
      INSERT INTO route_requests (
        id, scenario_id, agent_id, home_region, vehicle_class, status,
        idempotency_key, input, crdb_region
      ) VALUES ($1, $2, 'CONTENTION-FIXTURE', 'us-east-1', 'medium-cargo',
                'committed', $3, $4, 'aws-us-east-1')
    `,
    [
      routeId,
      scenarioId,
      `contention-${randomUUID()}`,
      JSON.stringify({ contenders: 100 }),
    ],
  );
  await pool.query(
    `
      INSERT INTO route_decisions (
        id, scenario_id, route_request_id, agent_id, home_region,
        corridor_id, state, maneuver_id, maneuver, safety_result,
        retry_count, decision_hlc, crdb_region
      ) VALUES (
        $1, $2, $3, 'CONTENTION-FIXTURE', 'us-east-1', 'VERIFY-ONLY',
        'committed', 'VERIFY', $4, $5, 0,
        cluster_logical_timestamp()::STRING, 'aws-us-east-1'
      )
    `,
    [
      decisionId,
      scenarioId,
      routeId,
      JSON.stringify({ label: "contention verification" }),
      JSON.stringify({ valid: true }),
    ],
  );

  const attempts = await Promise.allSettled(
    Array.from({ length: 100 }, () =>
      pool.query(
        `
          INSERT INTO occupancy_claims (
            id, scenario_id, route_decision_id, cell_id, slot_start,
            slot_end, exclusion_slot, home_region, crdb_region
          ) VALUES (
            $1, $2, $3, $4, $5, $5 + interval '5 seconds',
            0, 'us-east-1', 'aws-us-east-1'
          )
        `,
        [randomUUID(), scenarioId, decisionId, cellId, slotStart],
      ),
    ),
  );
  const committed = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  const count = await pool.query(
    `
      SELECT count(*)::INT AS count
        FROM occupancy_claims
       WHERE cell_id = $1 AND slot_start = $2 AND exclusion_slot = 0
    `,
    [cellId, slotStart],
  );
  console.log(JSON.stringify({
    contenders: attempts.length,
    committed: committed.length,
    rejected: rejected.length,
    storedClaims: count.rows[0].count,
    rejectionCodes: [...new Set(rejected.map((attempt) => attempt.reason?.code))],
  }, null, 2));
} finally {
  await pool.query(
    "DELETE FROM occupancy_claims WHERE scenario_id = $1",
    [scenarioId],
  ).catch(() => {});
  await pool.query(
    "DELETE FROM route_decisions WHERE scenario_id = $1",
    [scenarioId],
  ).catch(() => {});
  await pool.query(
    "DELETE FROM route_requests WHERE scenario_id = $1",
    [scenarioId],
  ).catch(() => {});
  await pool.end();
}
