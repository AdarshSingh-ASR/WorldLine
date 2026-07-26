import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secretId = process.env.WORLDLINE_DATABASE_SECRET_ID ?? "worldline/database";
const client = new SecretsManagerClient({
  region: process.env.WORLDLINE_AWS_REGION ?? "us-east-1",
});
const current = await client.send(
  new GetSecretValueCommand({ SecretId: secretId }),
);

let value;
try {
  value = JSON.parse(current.SecretString);
} catch {
  value = Object.fromEntries(
    [...current.SecretString.matchAll(/(\w+):(postgresql:\/\/[^,}]+)/g)].map(
      ([, key, url]) => [key, url],
    ),
  );
}

for (const key of [
  "migrationDatabaseUrl",
  "runtimeDatabaseUrl",
  "cdcDatabaseUrl",
  "auditDatabaseUrl",
]) {
  if (!value[key]?.startsWith("postgresql://")) {
    throw new Error(`Database secret is missing ${key}`);
  }
}

await client.send(
  new PutSecretValueCommand({
    SecretId: secretId,
    SecretString: JSON.stringify(value),
  }),
);
console.log("WORLDLINE database secret normalized");
