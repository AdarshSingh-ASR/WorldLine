import assert from "node:assert/strict";
import test from "node:test";
import { parseChangefeedRow, projectionKey } from "../src/projection.mjs";

test("normalizes and keys a wrapped CockroachDB changefeed event", () => {
  const event = parseChangefeedRow({
    topic: Buffer.from("worldline.public.commit_receipts"),
    key: Buffer.from('["aws-us-east-1","receipt-1"]'),
    value: Buffer.from(JSON.stringify({
      payload: {
        after: { id: "receipt-1", state: "committed" },
        before: null,
        updated: "1785063718442913000.0000000002",
      },
    })),
  });
  assert.equal(event.sourceTable, "commit_receipts");
  assert.equal(event.sourceKey, "receipt-1");
  assert.equal(event.eventOp, "insert");
  assert.equal(
    projectionKey(event),
    "commit_receipts:receipt-1:1785063718442913000.0000000002",
  );
});

test("recognizes resolved timestamp events", () => {
  assert.deepEqual(
    parseChangefeedRow({ resolved: "1785063718442913000.0000000002" }),
    { type: "resolved", resolved: "1785063718442913000.0000000002" },
  );
});
