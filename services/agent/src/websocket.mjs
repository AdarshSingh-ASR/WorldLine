import pg from "pg";
import { loadConfig } from "./config.mjs";

const config = loadConfig();

export async function handler(event) {
  if (!config.databaseUrl) return { statusCode: 503, body: "Database unavailable" };
  const connectionId = event.requestContext?.connectionId;
  const routeKey = event.requestContext?.routeKey;
  if (!connectionId) return { statusCode: 400, body: "Missing connection ID" };

  const client = new pg.Client({
    connectionString: config.databaseUrl,
    application_name: "worldline-websocket",
  });
  await client.connect();
  try {
    if (routeKey === "$connect") {
      const region =
        event.queryStringParameters?.region ??
        event.headers?.["cloudfront-viewer-country"] ??
        "global";
      await client.query(
        `
          UPSERT INTO stream_clients (
            connection_id, region, connected_at, expires_at
          ) VALUES ($1, $2, now(), now() + interval '2 hours')
        `,
        [connectionId, region],
      );
    } else if (routeKey === "$disconnect") {
      await client.query(
        "DELETE FROM stream_clients WHERE connection_id = $1",
        [connectionId],
      );
    }
    return { statusCode: 200, body: "ok" };
  } finally {
    await client.end();
  }
}
