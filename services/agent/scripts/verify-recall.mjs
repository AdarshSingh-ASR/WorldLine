/**
 * Proves that episodic recall is filtered before it is approximate, and that
 * the distributed vector index is actually in the query path.
 *
 * Run: npm run verify:recall
 */
import pg from "pg";
import { loadConfig } from "../src/config.mjs";
import { vectorLiteral } from "../src/invariants.mjs";
import { WorldlineProviders } from "../src/providers.mjs";
import { scenario } from "../src/repository.mjs";

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error("WORLDLINE_DATABASE_URL is required");
}

const embedded = await new WorldlineProviders(config).embedScenario(
  scenario.description,
);
const vector = vectorLiteral(embedded.vector);
console.log(`scenario embedded via ${embedded.provider} (${embedded.vector.length}d)`);

const client = new pg.Client({
  connectionString: config.databaseUrl,
  application_name: "worldline-verify-recall",
});
await client.connect();

let exitCode = 0;

try {
  const all = await client.query(
    `
      SELECT id, home_region, vehicle_class, outcome, maneuver_id,
             round((1 - (embedding <=> $1::VECTOR))::NUMERIC, 4) AS similarity
        FROM maneuver_memories
       ORDER BY embedding <=> $1::VECTOR
    `,
    [vector],
  );

  console.log("\nevery memory, ranked by cosine against the live scenario:");
  for (const row of all.rows) {
    const reachable =
      row.outcome === "verified-safe" &&
      row.home_region === scenario.homeRegion &&
      row.vehicle_class === scenario.vehicleClass;
    const reason = !reachable
      ? row.outcome !== "verified-safe"
        ? `outcome=${row.outcome}`
        : row.vehicle_class !== scenario.vehicleClass
          ? `vehicle_class=${row.vehicle_class}`
          : `home_region=${row.home_region}`
      : "";
    console.log(
      `  ${reachable ? "reachable" : "EXCLUDED "}  ${row.id}  ${row.similarity}  ${row.maneuver_id}  ${reason}`,
    );
  }

  const recalled = await client.query(
    `
      SELECT id, round((1 - (embedding <=> $3::VECTOR))::NUMERIC, 4) AS similarity
        FROM maneuver_memories
       WHERE home_region = $1 AND vehicle_class = $2 AND outcome = 'verified-safe'
       ORDER BY embedding <=> $3::VECTOR
       LIMIT 3
    `,
    [scenario.homeRegion, scenario.vehicleClass, vector],
  );

  console.log("\nwhat the agent recalls (prefix + outcome filtered, LIMIT 3):");
  recalled.rows.forEach((row, index) =>
    console.log(`  ${index + 1}. ${row.id}  ${row.similarity}`),
  );

  // The highest-scoring memory overall should NOT be the one recalled first.
  // If it is, the filters are not constraining anything.
  const topOverall = all.rows[0];
  const topRecalled = recalled.rows[0];
  if (topOverall && topRecalled && topOverall.id === topRecalled.id) {
    console.log(
      "\n  note: the closest memory is also the recalled one, so this corpus does not demonstrate filtering",
    );
  } else if (topOverall && topRecalled) {
    console.log(
      `\n  ${topOverall.id} scores ${topOverall.similarity} but is excluded; ${topRecalled.id} (${topRecalled.similarity}) is recalled instead`,
    );
  }

  const plan = await client.query(
    `
      EXPLAIN SELECT id FROM maneuver_memories
       WHERE home_region = $1 AND vehicle_class = $2 AND outcome = 'verified-safe'
       ORDER BY embedding <=> $3::VECTOR
       LIMIT 3
    `,
    [scenario.homeRegion, scenario.vehicleClass, vector],
  );
  const planText = plan.rows.map((row) => Object.values(row).join(" ")).join("\n");
  const usesVectorIndex = /vector search/i.test(planText);

  console.log(
    `\nquery plan: ${usesVectorIndex ? "USES the distributed vector index" : "FULL SCAN — vector index NOT used"}`,
  );
  if (!usesVectorIndex) {
    exitCode = 1;
    console.log(
      "  every equality predicate must sit in the vector index prefix.\n" +
        "  apply migrations/003_vector_index_outcome.sql (npm run migrate) with the migration identity.",
    );
    console.log(planText.split("\n").map((line) => "  " + line).join("\n"));
  }
} finally {
  await client.end();
}

process.exit(exitCode);
