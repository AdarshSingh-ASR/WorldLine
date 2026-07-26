import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig();
if (!config.migrationDatabaseUrl) {
  throw new Error("WORLDLINE_MIGRATION_DATABASE_URL is required");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const client = new pg.Client({
  connectionString: config.migrationDatabaseUrl,
  application_name: "worldline-migrator",
});
await client.connect();
try {
  await client.query(await readFile(resolve(root, "migrations/001_worldline_core.sql"), "utf8"));
  if (config.applyMultiRegion) {
    await client.query(await readFile(resolve(root, "migrations/002_multiregion.sql"), "utf8"));
  }
  console.log("WORLDLINE migrations applied");
} finally {
  await client.end();
}
