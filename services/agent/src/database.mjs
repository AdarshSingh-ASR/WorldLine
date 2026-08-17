import pg from "pg";

const { Pool } = pg;

export function createDatabase(databaseUrl) {
  if (!databaseUrl) return null;
  return new Pool({
    connectionString: databaseUrl,
    max: 12,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 8_000,
    application_name: "worldline-agent",
  });
}

const diagnostics = process.env.WORLDLINE_TXN_DIAGNOSTICS === "true";

export async function withSerializable(pool, operation, options = {}) {
  const maxAttempts = options.maxAttempts ?? 5;
  const priority = options.priority ?? "NORMAL";
  const label = options.label ?? "txn";
  const client = await pool.connect();
  let attempt = 0;
  try {
    // One round trip instead of three. Every saved round trip shortens the
    // window in which a serializable transaction can be invalidated, which
    // matters when the gateway region is not the region the rows live in.
    await client.query(
      `BEGIN ISOLATION LEVEL SERIALIZABLE; SET TRANSACTION PRIORITY ${priority}; SAVEPOINT cockroach_restart`,
    );
    while (attempt < maxAttempts) {
      const startedAt = Date.now();
      try {
      const value = await operation(client, attempt);
        await client.query("RELEASE SAVEPOINT cockroach_restart; COMMIT");
        if (diagnostics) {
          console.error(
            `[txn ${label}] committed attempt=${attempt} in ${Date.now() - startedAt}ms`,
          );
        }
      return { value, retryCount: attempt };
      } catch (error) {
        if (diagnostics) {
          console.error(
            `[txn ${label}] attempt=${attempt} failed after ${Date.now() - startedAt}ms code=${error?.code} ${String(error?.message).slice(0, 160)}`,
          );
        }
        if (error?.code !== "40001" || attempt + 1 >= maxAttempts) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
        try {
          await client.query("ROLLBACK TO SAVEPOINT cockroach_restart");
        } catch {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
        attempt += 1;
        const delay = Math.min(30 * 2 ** attempt + Math.floor(Math.random() * 20), 500);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("Serializable retry budget exhausted");
  } finally {
    client.release();
  }
}

export class TwoPartyBarrier {
  constructor() {
    this.waiters = [];
  }

  async wait() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      if (this.waiters.length === 2) {
        for (const release of this.waiters.splice(0)) release();
      }
    });
  }
}
