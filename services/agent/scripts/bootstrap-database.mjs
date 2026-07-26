import pg from "pg";

const adminUrl = process.env.WORLDLINE_CLUSTER_ADMIN_URL;
if (!adminUrl) throw new Error("WORLDLINE_CLUSTER_ADMIN_URL is required");

const client = new pg.Client({
  connectionString: adminUrl,
  application_name: "worldline-database-bootstrap",
});
await client.connect();
try {
  await client.query("CREATE DATABASE IF NOT EXISTS worldline");
  console.log("WORLDLINE database ready");
} finally {
  await client.end();
}
