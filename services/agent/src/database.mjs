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

export async function withSerializable(pool, operation, options = {}) {
  const maxAttempts = options.maxAttempts ?? 5;
  const priority = options.priority ?? "NORMAL";
  let attempt = 0;
  while (attempt < maxAttempts) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query(`SET TRANSACTION PRIORITY ${priority}`);
      const value = await operation(client, attempt);
      await client.query("COMMIT");
      return { value, retryCount: attempt };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error?.code === "40001" && attempt + 1 < maxAttempts) {
        attempt += 1;
        const delay = Math.min(30 * 2 ** attempt + Math.floor(Math.random() * 20), 500);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("Serializable retry budget exhausted");
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
