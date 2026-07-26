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
process.env.WORLDLINE_DATABASE_URL = value.runtimeDatabaseUrl;
await import("./verify-database.mjs");
