export function loadConfig(env = process.env) {
  return {
    databaseUrl: env.WORLDLINE_DATABASE_URL ?? "",
    migrationDatabaseUrl:
      env.WORLDLINE_MIGRATION_DATABASE_URL ?? env.WORLDLINE_DATABASE_URL ?? "",
    awsRegion: env.WORLDLINE_AWS_REGION ?? "us-east-1",
    // Bedrock model access is granted independently per AWS region. Keep the
    // control plane in us-east-1 while calling the authorized inference region.
    bedrockRegion: env.WORLDLINE_BEDROCK_REGION ?? "eu-west-1",
    bedrockModelId:
      env.WORLDLINE_BEDROCK_MODEL_ID ?? "eu.amazon.nova-micro-v1:0",
    embedModelId:
      env.WORLDLINE_EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
    bedrockState: env.WORLDLINE_BEDROCK_STATE ?? "configured",
    receiptBucket: env.WORLDLINE_RECEIPT_BUCKET ?? "",
    allowedOrigin: env.WORLDLINE_ALLOWED_ORIGIN ?? "http://localhost:5174",
    port: Number(env.WORLDLINE_PORT ?? 8790),
    // Opt-in only. Without a database the agent reports unavailable rather
    // than fabricating a decision, so the control room can never present
    // synthetic state as a real commit.
    demoFallback: env.WORLDLINE_DEMO_FALLBACK === "true",
    applyMultiRegion: env.WORLDLINE_APPLY_MULTI_REGION === "true",
  };
}
