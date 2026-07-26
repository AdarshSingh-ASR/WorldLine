import assert from "node:assert/strict";
import test from "node:test";
import { withSerializable } from "../src/database.mjs";

test("retries serialization failures through cockroach_restart", async () => {
  const queries = [];
  const operationAttempts = [];
  let releaseAttempts = 0;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "RELEASE SAVEPOINT cockroach_restart" && releaseAttempts++ === 0) {
        const error = new Error("restart transaction");
        error.code = "40001";
        throw error;
      }
      return {};
    },
    release() {
      queries.push("CLIENT RELEASE");
    },
  };
  const pool = { async connect() { return client; } };

  const result = await withSerializable(
    pool,
    async (_client, attempt) => {
      operationAttempts.push(attempt);
      return `attempt-${attempt}`;
    },
    { maxAttempts: 3 },
  );

  assert.equal(result.value, "attempt-1");
  assert.equal(result.retryCount, 1);
  assert.deepEqual(operationAttempts, [0, 1]);
  assert.ok(queries.includes("ROLLBACK TO SAVEPOINT cockroach_restart"));
  assert.ok(queries.includes("COMMIT"));
});
