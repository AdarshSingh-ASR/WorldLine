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
const value = JSON.parse(secret.SecretString);
const client = new pg.Client({ connectionString: value.migrationDatabaseUrl });
await client.connect();
try {
  const [regions, tables] = await Promise.all([
    client.query("SHOW REGIONS FROM DATABASE worldline"),
    client.query("SHOW TABLES FROM worldline.public"),
  ]);
  console.log(JSON.stringify({
    regions: regions.rows,
    tables: tables.rows.map((row) => ({
      name: row.table_name,
      locality: row.locality,
    })),
  }, null, 2));
} finally {
  await client.end();
}
