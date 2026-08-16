import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import pg from "pg";
import { parseChangefeedRow } from "./projection.mjs";

const { Pool } = pg;
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
  await db.query("DELETE FROM stream_clients WHERE expires_at <= now()");
  const clients = await db.query(
    "SELECT connection_id FROM stream_clients WHERE expires_at > now()",
  );
  const rows = clients.rows;
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

async function consumeOnce(controlPool) {
  const feedClient = new pg.Client({
    connectionString: databaseUrl,
    application_name: "worldline-changefeed",
  });
  try {
    await feedClient.connect();

    const cursor = await controlPool
      .query(
        `
          SELECT max(mvcc_timestamp) AS cursor
            FROM cdc_confirmations
           WHERE mvcc_timestamp ~ '^[0-9]+\\.[0-9]+$'
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
    await new Promise((resolve, reject) => {
      const query = feedClient.query(new pg.Query(sql));
      let processing = Promise.resolve();
      query.on("row", (row) => {
        processing = processing
          .then(async () => {
            const event = parseChangefeedRow(row);
            if (event.type === "resolved") {
              await broadcast(controlPool, event);
              return;
            }
            const inserted = await controlPool.query(
              `
                INSERT INTO cdc_confirmations (
                  source_table, source_key, mvcc_timestamp, event_op, payload,
                  crdb_region
                ) VALUES ($1, $2, $3, $4, $5, 'aws-us-east-1')
                ON CONFLICT DO NOTHING
                RETURNING source_key
              `,
              [
                event.sourceTable,
                event.sourceKey,
                event.mvccTimestamp,
                event.eventOp,
                JSON.stringify(event.payload),
              ],
            );
            if (
              inserted.rowCount > 0 &&
              event.sourceTable === "commit_receipts"
            ) {
              await controlPool.query(
                `
                  UPDATE commit_receipts
                     SET cdc_confirmed = true
                   WHERE id = $1 AND cdc_confirmed = false
                `,
                [event.sourceKey],
              );
            }
            if (inserted.rowCount > 0) await broadcast(controlPool, event);
          })
          .catch((error) => {
            console.error("changefeed event failed", error);
          });
      });
      query.once("error", (error) => {
        processing.finally(() => reject(error));
      });
      query.once("end", () => {
        processing.finally(resolve);
      });
    });
  } finally {
    await feedClient.end().catch(() => {});
  }
}

async function start() {
  const controlPool = new Pool({
    connectionString: databaseUrl,
    application_name: "worldline-changefeed-control",
    max: 4,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 8_000,
  });
  let delayMs = 500;
  while (true) {
    try {
      await consumeOnce(controlPool);
      throw new Error("changefeed ended");
    } catch (error) {
      console.error("changefeed reconnecting", error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 15_000);
    }
  }
}

await start();
