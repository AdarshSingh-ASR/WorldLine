import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({
  region: process.env.WORLDLINE_AWS_REGION ?? "us-east-1",
});
const secret = await client.send(
  new GetSecretValueCommand({
    SecretId: process.env.WORLDLINE_DATABASE_SECRET_ID ?? "worldline/database",
  }),
);
const value = JSON.parse(secret.SecretString);
process.env.WORLDLINE_MIGRATION_DATABASE_URL = value.migrationDatabaseUrl;
process.env.WORLDLINE_DATABASE_URL = value.runtimeDatabaseUrl;
process.env.WORLDLINE_APPLY_MULTI_REGION = "true";

await import("./migrate.mjs");
await import("./seed.mjs");
await import("./provision-roles.mjs");
