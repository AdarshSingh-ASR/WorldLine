import assert from "node:assert/strict";
import pg from "pg";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig();
if (!config.databaseUrl) throw new Error("WORLDLINE_DATABASE_URL is required");
const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();
try {
  const tables = await client.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
  `);
  const names = new Set(tables.rows.map((row) => row.table_name));
  for (const name of [
    "maneuver_memories",
    "memory_reads",
    "route_decisions",
    "occupancy_claims",
    "commit_receipts",
  ]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
  const indexes = await client.query("SHOW INDEXES FROM maneuver_memories");
  assert.ok(indexes.rows.some((row) => /vector/i.test(row.index_name)));
  const regions = await client.query("SHOW REGIONS FROM DATABASE worldline").catch(() => ({ rows: [] }));
  console.log(JSON.stringify({
    tables: names.size,
    vectorIndex: true,
    regions: regions.rows,
  }, null, 2));
} finally {
  await client.end();
}
