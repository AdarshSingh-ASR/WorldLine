import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createDatabase } from "../src/database.mjs";
import { WorldlineRepository } from "../src/repository.mjs";

const secrets = new SecretsManagerClient({
  region: process.env.WORLDLINE_AWS_REGION ?? "us-east-1",
});
const secret = await secrets.send(
  new GetSecretValueCommand({
    SecretId: process.env.WORLDLINE_DATABASE_SECRET_ID ?? "worldline/database",
  }),
);
const value = JSON.parse(secret.SecretString);
const pool = createDatabase(value.runtimeDatabaseUrl);
const repository = new WorldlineRepository(pool);
const startedAt = Date.now();
try {
  const result = await repository.resetDemo();
  console.log(JSON.stringify({
    ...result,
    elapsedMs: Date.now() - startedAt,
  }, null, 2));
} finally {
  await pool.end();
}
