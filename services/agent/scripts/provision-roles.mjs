import pg from "pg";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig();
if (!config.migrationDatabaseUrl) {
  throw new Error("WORLDLINE_MIGRATION_DATABASE_URL is required");
}

const client = new pg.Client({
  connectionString: config.migrationDatabaseUrl,
  application_name: "worldline-role-provisioner",
});

await client.connect();
try {
  await client.query("REVOKE CREATE ON SCHEMA public FROM public");
  await client.query(
    "GRANT CONNECT ON DATABASE worldline TO worldline_migrator, worldline_runtime, worldline_cdc, worldline_audit",
  );
  await client.query(
    "GRANT USAGE ON SCHEMA public TO worldline_migrator, worldline_runtime, worldline_cdc, worldline_audit",
  );
  await client.query(
    "GRANT CREATE ON DATABASE worldline TO worldline_migrator",
  );
  await client.query(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO worldline_runtime",
  );
  await client.query(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO worldline_cdc",
  );
  await client.query(
    "GRANT SELECT ON ALL TABLES IN SCHEMA public TO worldline_audit",
  );
  await client.query(
    "GRANT CHANGEFEED ON TABLE route_decisions, occupancy_claims, commit_receipts TO worldline_cdc",
  );
  await client.query(
    "ALTER DEFAULT PRIVILEGES FOR ROLE worldline_migrator GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO worldline_runtime",
  );
  await client.query(
    "ALTER DEFAULT PRIVILEGES FOR ROLE worldline_migrator GRANT SELECT ON TABLES TO worldline_audit",
  );
  for (const role of ["worldline_runtime", "worldline_cdc", "worldline_audit"]) {
    await client.query(`REVOKE admin FROM ${role}`);
  }
  console.log("WORLDLINE least-privilege roles provisioned");
} finally {
  await client.end();
}
