import pg from "pg";
import { loadConfig } from "../src/config.mjs";
import { vectorLiteral } from "../src/invariants.mjs";
import { WorldlineProviders } from "../src/providers.mjs";

const config = loadConfig();
if (!config.migrationDatabaseUrl) {
  throw new Error("WORLDLINE_MIGRATION_DATABASE_URL is required");
}
const text =
  "87 degree converging merge, 18.4 meters per second closure, 11.2 knot crosswind, asymmetric battery reserve";
const embedded = await new WorldlineProviders(config).embedScenario(text);
const vector = embedded.vector;
const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
await client.connect();
try {
  await client.query(
    `
      INSERT INTO maneuver_memories (
        id, home_region, vehicle_class, title, scenario, geometry,
        constraints, maneuver_id, maneuver, alternatives_rejected,
        outcome, provenance, confidence, occurred_at, embedding, crdb_region
      ) VALUES (
        'MEM-2041', 'ap-south-1', 'medium-cargo',
        'Converging approach under crosswind',
        $1, ST_GeomFromText('LINESTRING(103.851 1.290,103.852 1.291)', 4326),
        $2, 'MANEUVER-03', $3, $4, 'verified-safe', $5, 0.99,
        now() - interval '6 weeks', $6::VECTOR, 'aws-ap-south-1'
      )
      ON CONFLICT (id) DO UPDATE SET
        scenario = excluded.scenario,
        constraints = excluded.constraints,
        maneuver = excluded.maneuver,
        provenance = excluded.provenance,
        embedding = excluded.embedding
    `,
    [
      JSON.stringify({
        description: text,
        closureMps: 18.1,
        crosswindKn: 10.8,
        mergeAngleDeg: 87,
        batteries: [46, 72],
      }),
      JSON.stringify({ minimumSeparationM: 30, maximumDelayS: 15, batteryFloorPct: 20 }),
      JSON.stringify({ label: "Vertical separation / +38 m", altitudeDeltaM: 38, energyCostPct: 3.2 }),
      JSON.stringify(["MANEUVER-07", "MANEUVER-11"]),
      JSON.stringify({
        source: "signed-utm-telemetry",
        operator: "Singapore UTM",
        signature: "verified",
      }),
      vectorLiteral(vector),
    ],
  );
  for (const corridor of ["X-17", "X-17-ALT"]) {
    await client.query(
      `
        INSERT INTO corridor_capacity (
          scenario_id, corridor_id, home_region, capacity, used, revision
          , crdb_region
        ) VALUES ('ATLAS-X17', $1, 'us-east-1', 1, 0, 1, 'aws-us-east-1')
        ON CONFLICT (scenario_id, corridor_id)
        DO UPDATE SET
          home_region = 'us-east-1',
          capacity = 1,
          used = 0,
          revision = corridor_capacity.revision + 1,
          crdb_region = 'aws-us-east-1'
      `,
      [corridor],
    );
  }
  await client.query(
    `
      INSERT INTO safety_policies (id, version, state, rules)
      VALUES (
        'UTM-SEPARATION', 'UTM-4.7', 'active',
        '{"minimumSeparationM":30,"batteryFloorPct":20,"maximumDelayS":15}'
      )
      ON CONFLICT (id) DO UPDATE SET version = excluded.version, rules = excluded.rules
    `,
  );
  console.log(`WORLDLINE episodic memory seeded via ${embedded.provider}`);
} finally {
  await client.end();
}
