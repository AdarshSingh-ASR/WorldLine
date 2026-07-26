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
  const jobs = await client.query(`
    SELECT job_id, job_type, status, fraction_completed, description
      FROM [SHOW JOBS]
     WHERE status IN ('pending', 'running', 'paused', 'reverting')
     ORDER BY created
  `);
  console.log(JSON.stringify(jobs.rows, null, 2));
} finally {
  await client.end();
}
