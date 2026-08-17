import pg from "pg";
import { loadConfig } from "../src/config.mjs";
import { vectorLiteral } from "../src/invariants.mjs";
import { WorldlineProviders } from "../src/providers.mjs";

/**
 * Episodic memory corpus.
 *
 * Each memory is embedded from its OWN description, never from the live
 * scenario text. Embedding a memory from the query string produces a cosine
 * similarity of exactly 1.0, which looks fabricated and proves nothing about
 * ranking.
 *
 * The corpus is deliberately mixed. Four entries are reachable by the ATLAS-X17
 * scenario and rank against each other. Three are unreachable by design and
 * exist to demonstrate that recall is filtered before it is approximate:
 *
 *   MEM-1388  the closest text match in the corpus, but outcome='rejected'
 *   MEM-1204  matching geometry, but a different vehicle class
 *   MEM-1150  matching geometry and class, but a different home region
 *
 * If the prefix columns and the outcome predicate were not doing real work,
 * MEM-1388 would win the search. It never appears.
 */
const memories = [
  {
    id: "MEM-2041",
    homeRegion: "ap-south-1",
    vehicleClass: "medium-cargo",
    title: "Converging approach under crosswind",
    description:
      "84 degree converging merge, 17.6 meters per second closure, 9.8 knot crosswind, asymmetric battery reserve between paired cargo vehicles",
    scenario: {
      mergeAngleDeg: 84,
      closureMps: 17.6,
      crosswindKn: 9.8,
      batteries: [46, 72],
    },
    geometry: "LINESTRING(103.851 1.290,103.856 1.294,103.861 1.297)",
    maneuverId: "MANEUVER-03",
    maneuver: {
      label: "Vertical separation / +38 m",
      altitudeDeltaM: 38,
      energyCostPct: 3.2,
    },
    rejected: ["MANEUVER-07", "MANEUVER-11"],
    outcome: "verified-safe",
    confidence: 0.99,
    occurredAt: "6 weeks",
    provenance: {
      source: "signed-utm-telemetry",
      operator: "Singapore UTM",
      signature: "verified",
    },
    region: "aws-ap-south-1",
  },
  {
    id: "MEM-1876",
    homeRegion: "ap-south-1",
    vehicleClass: "medium-cargo",
    title: "Temporal hold at tower shear boundary",
    description:
      "72 degree merge, 12.4 meters per second closure, 21.5 knot gusting crosswind near a tower shear boundary, balanced battery reserve",
    scenario: {
      mergeAngleDeg: 72,
      closureMps: 12.4,
      crosswindKn: 21.5,
      batteries: [68, 71],
    },
    geometry: "LINESTRING(72.865 19.075,72.869 19.079,72.874 19.082)",
    maneuverId: "MANEUVER-07",
    maneuver: {
      label: "Temporal hold / +11 s",
      altitudeDeltaM: 0,
      energyCostPct: 2.1,
    },
    rejected: ["MANEUVER-03"],
    outcome: "verified-safe",
    confidence: 0.94,
    occurredAt: "4 months",
    provenance: {
      source: "signed-utm-telemetry",
      operator: "Mumbai UTM",
      signature: "verified",
    },
    region: "aws-ap-south-1",
  },
  {
    id: "MEM-1642",
    homeRegion: "ap-south-1",
    vehicleClass: "medium-cargo",
    title: "Lateral bypass around a static exclusion",
    description:
      "41 degree shallow overtake, 8.2 meters per second closure, calm air, one vehicle holding a low battery reserve",
    scenario: {
      mergeAngleDeg: 41,
      closureMps: 8.2,
      crosswindKn: 1.4,
      batteries: [28, 65],
    },
    geometry: "LINESTRING(80.270 13.082,80.275 13.086,80.279 13.089)",
    maneuverId: "MANEUVER-11",
    maneuver: {
      label: "Lateral bypass / east 52 m",
      altitudeDeltaM: 4,
      energyCostPct: 5.8,
    },
    rejected: ["MANEUVER-03", "MANEUVER-07"],
    outcome: "verified-safe",
    confidence: 0.88,
    occurredAt: "9 months",
    provenance: {
      source: "signed-utm-telemetry",
      operator: "Chennai UTM",
      signature: "verified",
    },
    region: "aws-ap-south-1",
  },
  {
    id: "MEM-1509",
    homeRegion: "ap-south-1",
    vehicleClass: "medium-cargo",
    title: "High closure near head-on resolution",
    description:
      "168 degree near head-on convergence, 31.7 meters per second closure, 6.1 knot crosswind, symmetric battery reserve",
    scenario: {
      mergeAngleDeg: 168,
      closureMps: 31.7,
      crosswindKn: 6.1,
      batteries: [77, 79],
    },
    geometry: "LINESTRING(77.591 12.972,77.596 12.976,77.601 12.979)",
    maneuverId: "MANEUVER-03",
    maneuver: {
      label: "Vertical separation / +38 m",
      altitudeDeltaM: 38,
      energyCostPct: 3.2,
    },
    rejected: ["MANEUVER-11"],
    outcome: "verified-safe",
    confidence: 0.91,
    occurredAt: "14 months",
    provenance: {
      source: "signed-utm-telemetry",
      operator: "Bengaluru UTM",
      signature: "verified",
    },
    region: "aws-ap-south-1",
  },
  // --- deliberately unreachable by the ATLAS-X17 scenario -----------------
  {
    id: "MEM-1388",
    homeRegion: "ap-south-1",
    vehicleClass: "medium-cargo",
    title: "Rejected: insufficient vertical margin at critical battery",
    description:
      "89 degree converging merge, 19.1 meters per second closure, 14.2 knot crosswind, critical battery reserve on both vehicles",
    scenario: {
      mergeAngleDeg: 89,
      closureMps: 19.1,
      crosswindKn: 14.2,
      batteries: [17, 21],
    },
    geometry: "LINESTRING(103.845 1.284,103.849 1.288,103.854 1.291)",
    maneuverId: "MANEUVER-03",
    maneuver: {
      label: "Vertical separation / +38 m",
      altitudeDeltaM: 38,
      energyCostPct: 3.2,
    },
    rejected: ["MANEUVER-07", "MANEUVER-11"],
    // Closest text match in the corpus. Unreachable because recall requires a
    // verified outcome, which is the whole point of storing the outcome.
    outcome: "rejected",
    confidence: 0.42,
    occurredAt: "7 weeks",
    provenance: {
      source: "signed-utm-telemetry",
      operator: "Singapore UTM",
      signature: "verified",
    },
    region: "aws-ap-south-1",
  },
  {
    id: "MEM-1204",
    homeRegion: "ap-south-1",
    vehicleClass: "heavy-lift",
    title: "Heavy-lift vertical separation under crosswind",
    description:
      "86 degree converging merge, 18.0 meters per second closure, 10.4 knot crosswind, asymmetric battery reserve",
    scenario: {
      mergeAngleDeg: 86,
      closureMps: 18.0,
      crosswindKn: 10.4,
      batteries: [51, 74],
    },
    geometry: "LINESTRING(103.860 1.300,103.864 1.304,103.869 1.307)",
    maneuverId: "MANEUVER-03",
    maneuver: {
      label: "Vertical separation / +38 m",
      altitudeDeltaM: 38,
      energyCostPct: 4.9,
    },
    rejected: ["MANEUVER-07"],
    outcome: "verified-safe",
    confidence: 0.96,
    occurredAt: "5 months",
    provenance: {
      source: "signed-utm-telemetry",
      operator: "Singapore UTM",
      signature: "verified",
    },
    region: "aws-ap-south-1",
  },
  {
    id: "MEM-1150",
    homeRegion: "eu-west-1",
    vehicleClass: "medium-cargo",
    title: "Converging merge over estuary approach",
    description:
      "85 degree converging merge, 17.9 meters per second closure, 11.0 knot crosswind, asymmetric battery reserve",
    scenario: {
      mergeAngleDeg: 85,
      closureMps: 17.9,
      crosswindKn: 11.0,
      batteries: [44, 70],
    },
    geometry: "LINESTRING(-6.259 53.343,-6.254 53.347,-6.249 53.350)",
    maneuverId: "MANEUVER-03",
    maneuver: {
      label: "Vertical separation / +38 m",
      altitudeDeltaM: 38,
      energyCostPct: 3.4,
    },
    rejected: ["MANEUVER-11"],
    outcome: "verified-safe",
    confidence: 0.93,
    occurredAt: "3 months",
    provenance: {
      source: "signed-utm-telemetry",
      operator: "Dublin UTM",
      signature: "verified",
    },
    region: "aws-eu-west-1",
  },
];

const LOCAL_REGION_SQL =
  "default_to_database_primary_region(gateway_region())::crdb_internal_region";

const config = loadConfig();
if (!config.migrationDatabaseUrl) {
  throw new Error("WORLDLINE_MIGRATION_DATABASE_URL is required");
}

const providers = new WorldlineProviders(config);
const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
await client.connect();

try {
  const providerCounts = new Map();

  for (const memory of memories) {
    // Embedded from the memory's own description. This is what makes the
    // similarity scores meaningful.
    const embedded = await providers.embedScenario(memory.description);
    providerCounts.set(
      embedded.provider,
      (providerCounts.get(embedded.provider) ?? 0) + 1,
    );

    await client.query(
      `
        INSERT INTO maneuver_memories (
          id, home_region, vehicle_class, title, scenario, geometry,
          constraints, maneuver_id, maneuver, alternatives_rejected,
          outcome, provenance, confidence, occurred_at, embedding, crdb_region
        ) VALUES (
          $1, $2, $3, $4, $5, ST_GeomFromText($6, 4326),
          $7, $8, $9, $10, $11, $12, $13,
          now() - $14::INTERVAL, $15::VECTOR, $16
        )
        ON CONFLICT (id) DO UPDATE SET
          home_region = excluded.home_region,
          vehicle_class = excluded.vehicle_class,
          title = excluded.title,
          scenario = excluded.scenario,
          geometry = excluded.geometry,
          constraints = excluded.constraints,
          maneuver_id = excluded.maneuver_id,
          maneuver = excluded.maneuver,
          alternatives_rejected = excluded.alternatives_rejected,
          outcome = excluded.outcome,
          provenance = excluded.provenance,
          confidence = excluded.confidence,
          occurred_at = excluded.occurred_at,
          embedding = excluded.embedding
      `,
      [
        memory.id,
        memory.homeRegion,
        memory.vehicleClass,
        memory.title,
        JSON.stringify({
          description: memory.description,
          ...memory.scenario,
        }),
        memory.geometry,
        JSON.stringify({
          minimumSeparationM: 30,
          maximumDelayS: 15,
          batteryFloorPct: 20,
        }),
        memory.maneuverId,
        JSON.stringify(memory.maneuver),
        JSON.stringify(memory.rejected),
        memory.outcome,
        JSON.stringify(memory.provenance),
        memory.confidence,
        memory.occurredAt,
        vectorLiteral(embedded.vector),
        memory.region,
      ],
    );
  }

  for (const corridor of ["X-17", "X-17-ALT"]) {
    await client.query(
      `
        INSERT INTO corridor_capacity (
          scenario_id, corridor_id, home_region, capacity, used, revision,
          crdb_region
        ) VALUES ('ATLAS-X17', $1, 'us-east-1', 1, 0, 1, ${LOCAL_REGION_SQL})
        ON CONFLICT (scenario_id, corridor_id)
        DO UPDATE SET
          home_region = 'us-east-1',
          capacity = 1,
          used = 0,
          revision = corridor_capacity.revision + 1,
          crdb_region = ${LOCAL_REGION_SQL}
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

  const summary = [...providerCounts.entries()]
    .map(([provider, count]) => `${count} via ${provider}`)
    .join(", ");
  console.log(`WORLDLINE seeded ${memories.length} episodic memories (${summary})`);
  const reachable = memories.filter(
    (memory) =>
      memory.outcome === "verified-safe" &&
      memory.homeRegion === "ap-south-1" &&
      memory.vehicleClass === "medium-cargo",
  ).length;
  console.log(
    `  ${reachable} reachable by ATLAS-X17, ${memories.length - reachable} excluded by prefix or outcome`,
  );
} finally {
  await client.end();
}
