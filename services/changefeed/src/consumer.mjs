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

/**
 * Recording a confirmation and pushing it to browsers are separate concerns.
 * The durable projection into cdc_confirmations is what makes a committed
 * future authoritative; the WebSocket fan-out is an optional transport. Keeping
 * the endpoint optional lets the projection run anywhere — including local
 * development with no AWS resources — instead of refusing to start.
 */
const management = socketEndpoint
  ? new ApiGatewayManagementApiClient({
      region: awsRegion,
      endpoint: socketEndpoint.replace(/^wss:/, "https:"),
    })
  : null;

if (!management) {
  console.warn(
    "WORLDLINE_WEBSOCKET_ENDPOINT is not set: recording CDC confirmations without WebSocket fan-out",
  );
}

async function broadcast(db, event) {
  if (!management) return;
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

    /**
     * Resume cursor.
     *
     * mvcc_timestamp is a STRING column, so max() compares lexically —
     * "9…" sorts above "10…" — which can hand the changefeed a cursor ahead of
     * what was actually recorded and silently skip events. The numeric cast
     * fixes the ordering.
     *
     * The candidate set is bounded by observed_at, which is indexed, because an
     * unbounded sort over an append-only confirmation table is a full scan that
     * grows forever. A max over a subset can only be lower than the true
     * maximum, never higher: resuming early replays events that the primary key
     * then dedupes, whereas resuming late would lose them.
     */
    const cursor = await controlPool
      .query(
        `
          SELECT max(mvcc_timestamp::DECIMAL)::STRING AS cursor
            FROM (
              SELECT mvcc_timestamp
                FROM cdc_confirmations
               WHERE mvcc_timestamp ~ '^[0-9]+\\.[0-9]+$'
               ORDER BY observed_at DESC
               LIMIT 500
            )
        `,
      )
      .then((result) => result.rows[0]?.cursor);
    console.log(
      cursor
        ? `changefeed resuming from cursor ${cursor}`
        : "changefeed starting without a cursor (no prior confirmations)",
    );
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
    // Liveness. A changefeed that stops delivering looks identical to a quiet
    // one from the outside, so the counters are reported on an interval: a
    // heartbeat with no confirmations while routes are committing is the signal
    // that something is wrong.
    let confirmations = 0;
    let duplicates = 0;
    let failures = 0;
    let lastResolved = null;
    const heartbeat = setInterval(() => {
      console.log(
        `changefeed alive: ${confirmations} recorded, ${duplicates} duplicate, ${failures} failed, last resolved ${lastResolved ?? "none"}`,
      );
    }, 30_000);
    heartbeat.unref?.();

    await new Promise((resolve, reject) => {
      const query = feedClient.query(new pg.Query(sql));
      let processing = Promise.resolve();
      query.on("row", (row) => {
        processing = processing
          .then(async () => {
            const event = parseChangefeedRow(row);
            if (event.type === "resolved") {
              lastResolved = event.resolved;
              await broadcast(controlPool, event);
              return;
            }
            const inserted = await controlPool.query(
              `
                INSERT INTO cdc_confirmations (
                  source_table, source_key, mvcc_timestamp, event_op, payload,
                  crdb_region
                ) VALUES (
                  $1, $2, $3, $4, $5,
                  default_to_database_primary_region(gateway_region())::crdb_internal_region
                )
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
            if (inserted.rowCount > 0) {
              confirmations += 1;
              await broadcast(controlPool, event);
            } else {
              duplicates += 1;
            }
          })
          .catch((error) => {
            failures += 1;
            console.error("changefeed event failed", error.message);
          });
      });
      query.once("error", (error) => {
        processing.finally(() => reject(error));
      });
      query.once("end", () => {
        processing.finally(resolve);
      });
    }).finally(() => {
      clearInterval(heartbeat);
      console.log(
        `changefeed run ended: ${confirmations} recorded, ${duplicates} duplicate, ${failures} failed`,
      );
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

  // An idle pool client whose TCP connection dies emits an error on the pool.
  // Unhandled, that terminates the process; the supervision loop below is the
  // thing that is supposed to handle failure.
  controlPool.on("error", (error) => {
    console.error("changefeed control pool error", error.message);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`changefeed received ${signal}, shutting down`);
    // Ends the feed connection too, which cancels the changefeed server-side
    // instead of leaving it to time out.
    await controlPool.end().catch(() => {});
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => void shutdown(signal));
  }

  const MIN_DELAY_MS = 500;
  const MAX_DELAY_MS = 15_000;
  let delayMs = MIN_DELAY_MS;
  let consecutiveFailures = 0;

  while (!shuttingDown) {
    const startedAt = Date.now();
    try {
      await consumeOnce(controlPool);
      throw new Error("changefeed ended");
    } catch (error) {
      if (shuttingDown) break;
      const ranFor = Date.now() - startedAt;
      // A feed that stayed up is a success even though it ended. Without this
      // reset the backoff ratchets to its ceiling after the first blip and
      // stays there for the life of the process, so a later reconnect waits
      // 15s for no reason.
      if (ranFor > 60_000) {
        consecutiveFailures = 0;
        delayMs = MIN_DELAY_MS;
      } else {
        consecutiveFailures += 1;
      }
      console.error(
        `changefeed reconnecting in ${delayMs}ms after ${ranFor}ms (consecutive failures: ${consecutiveFailures}): ${error.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
    }
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("changefeed unhandled rejection", reason);
});

await start();
