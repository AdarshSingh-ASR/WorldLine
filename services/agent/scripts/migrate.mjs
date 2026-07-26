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
function statements(sql) {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyFile(client, filename) {
  const sql = await readFile(resolve(root, "migrations", filename), "utf8");
  const migrationStatements = statements(sql);
  for (let index = 0; index < migrationStatements.length; index += 1) {
    const statement = migrationStatements[index];
    const label = statement.replace(/\s+/g, " ").slice(0, 100);
    const localityMatch = statement.match(
      /^ALTER TABLE\s+([a-z_]+)\s+SET LOCALITY\s+(REGIONAL BY ROW|GLOBAL)$/i,
    );
    if (localityMatch) {
      const { rows } = await client.query(
        `SELECT locality FROM [SHOW TABLES FROM worldline.public] WHERE table_name = $1`,
        [localityMatch[1]],
      );
      if (rows[0]?.locality?.toUpperCase() === localityMatch[2].toUpperCase()) {
        console.log(`[${filename} ${index + 1}/${migrationStatements.length}] already applied`);
        continue;
      }
    }

    if (/^CREATE VECTOR INDEX IF NOT EXISTS\s+maneuver_memory_vector_idx/i.test(statement)) {
      const { rows } = await client.query(
        `SELECT count(*)::INT AS count
           FROM [SHOW INDEXES FROM maneuver_memories]
          WHERE index_name = 'maneuver_memory_vector_idx'`,
      );
      if (rows[0]?.count > 0) {
        console.log(`[${filename} ${index + 1}/${migrationStatements.length}] already applied`);
        continue;
      }
    }

    console.log(`[${filename} ${index + 1}/${migrationStatements.length}] ${label}`);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await client.query(statement);
        break;
      } catch (error) {
        if (
          ["55000", "55P03"].includes(error.code) &&
          attempt < 60
        ) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          continue;
        }
        throw error;
      }
    }
  }
}

const client = new pg.Client({
  connectionString: config.migrationDatabaseUrl,
  application_name: "worldline-migrator",
});
await client.connect();
try {
  await applyFile(client, "001_worldline_core.sql");
  if (config.applyMultiRegion) {
    await applyFile(client, "002_multiregion.sql");
  }
  console.log("WORLDLINE migrations applied");
} finally {
  await client.end();
}
