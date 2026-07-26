export function loadConfig(env = process.env) {
  return {
    databaseUrl: env.WORLDLINE_DATABASE_URL ?? "",
    migrationDatabaseUrl:
      env.WORLDLINE_MIGRATION_DATABASE_URL ?? env.WORLDLINE_DATABASE_URL ?? "",
    awsRegion: env.WORLDLINE_AWS_REGION ?? "us-east-1",
    bedrockModelId: env.WORLDLINE_BEDROCK_MODEL_ID ?? "amazon.nova-lite-v1:0",
    embedModelId:
      env.WORLDLINE_EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
    bedrockState: env.WORLDLINE_BEDROCK_STATE ?? "configured",
    receiptBucket: env.WORLDLINE_RECEIPT_BUCKET ?? "",
    allowedOrigin: env.WORLDLINE_ALLOWED_ORIGIN ?? "http://localhost:5174",
    port: Number(env.WORLDLINE_PORT ?? 8790),
    demoFallback: env.WORLDLINE_DEMO_FALLBACK !== "false",
    applyMultiRegion: env.WORLDLINE_APPLY_MULTI_REGION === "true",
  };
}
