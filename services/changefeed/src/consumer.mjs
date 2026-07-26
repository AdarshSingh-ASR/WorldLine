import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import pg from "pg";
import { parseChangefeedRow } from "./projection.mjs";

const databaseUrl = process.env.WORLDLINE_DATABASE_URL;
const socketEndpoint = process.env.WORLDLINE_WEBSOCKET_ENDPOINT;
const awsRegion = process.env.WORLDLINE_AWS_REGION ?? "us-east-1";
if (!databaseUrl) throw new Error("WORLDLINE_DATABASE_URL is required");
if (!socketEndpoint) throw new Error("WORLDLINE_WEBSOCKET_ENDPOINT is required");

const management = new ApiGatewayManagementApiClient({
  region: awsRegion,
  endpoint: socketEndpoint.replace(/^wss:/, "https:"),
});

async function broadcast(db, event) {
  const clients = await db.query(
    `
      DELETE FROM stream_clients WHERE expires_at <= now();
      SELECT connection_id FROM stream_clients WHERE expires_at > now();
    `,
  );
  const rows = clients.at(-1)?.rows ?? clients.rows ?? [];
  const data = Buffer.from(JSON.stringify(event));
  await Promise.allSettled(
    rows.map(async ({ connection_id: connectionId }) => {
      try {
        await management.send(
          new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }),
        );
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 410) {
          await management.send(
            new DeleteConnectionCommand({ ConnectionId: connectionId }),
          ).catch(() => {});
          await db.query(
            "DELETE FROM stream_clients WHERE connection_id = $1",
            [connectionId],
          );
          return;
        }
        throw error;
      }
    }),
  );
}

async function start() {
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: "worldline-changefeed",
  });
  await client.connect();
  await client.query("SET results_buffer_size = '0'");

  const cursor = await client
    .query(
      `
        SELECT max(mvcc_timestamp) AS cursor
          FROM cdc_confirmations
      `,
    )
    .then((result) => result.rows[0]?.cursor);
  const cursorOption = cursor ? `cursor='${cursor}',` : "";
  const sql = `
    CREATE CHANGEFEED FOR
      route_decisions,
      occupancy_claims,
      commit_receipts
    WITH ${cursorOption}
      updated,
      diff,
      resolved='1s',
      min_checkpoint_frequency='1s',
      envelope='wrapped'
  `;
  const query = client.query(new pg.Query(sql));
  query.on("row", async (row) => {
    try {
      const event = parseChangefeedRow(row);
      if (event.type === "resolved") {
        await broadcast(client, event);
        return;
      }
      const inserted = await client.query(
        `
          INSERT INTO cdc_confirmations (
            source_table, source_key, mvcc_timestamp, event_op, payload
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING
          RETURNING source_key
        `,
        [
          event.sourceTable,
          event.sourceKey,
          event.mvccTimestamp,
          event.eventOp,
          event.payload,
        ],
      );
      if (inserted.rowCount > 0) await broadcast(client, event);
    } catch (error) {
      console.error("changefeed event failed", error);
    }
  });
  query.on("error", (error) => {
    console.error("changefeed stopped", error);
    process.exitCode = 1;
  });
  query.on("end", () => {
    console.error("changefeed ended");
    process.exitCode = 1;
  });
}

await start();
