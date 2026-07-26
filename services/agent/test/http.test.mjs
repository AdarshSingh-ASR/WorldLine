import assert from "node:assert/strict";
import test from "node:test";

process.env.WORLDLINE_ALLOWED_ORIGIN = "https://worldline.example";
process.env.WORLDLINE_DEMO_FALLBACK = "true";

const { handler } = await import("../src/index.mjs");

function event({
  method = "GET",
  path = "/health",
  body,
  headers = {},
} = {}) {
  return {
    body,
    headers,
    rawPath: path,
    requestContext: { http: { method } },
  };
}

test("does not reflect an untrusted request origin", async () => {
  const result = await handler(event({
    headers: { origin: "https://evil.example" },
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(
    result.headers["access-control-allow-origin"],
    "https://worldline.example",
  );
});

test("returns 400 for malformed JSON", async () => {
  const result = await handler(event({
    method: "POST",
    path: "/v1/demo/race",
    body: "{bad",
    headers: { "x-idempotency-key": "malformed-json-test" },
  }));
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).detail, "Malformed JSON request body");
});
