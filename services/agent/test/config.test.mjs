import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

test("defaults to the credit-efficient Bedrock model pair", () => {
  const config = loadConfig({});

  assert.equal(config.bedrockModelId, "eu.amazon.nova-micro-v1:0");
  assert.equal(config.embedModelId, "amazon.titan-embed-text-v2:0");
  assert.equal(config.bedrockRegion, "eu-west-1");
});

test("allows deployment-time Bedrock model overrides", () => {
  const config = loadConfig({
    WORLDLINE_BEDROCK_MODEL_ID: "example.ranker",
    WORLDLINE_EMBED_MODEL_ID: "example.embedder",
    WORLDLINE_BEDROCK_STATE: "live",
    WORLDLINE_BEDROCK_REGION: "ap-south-1",
  });

  assert.equal(config.bedrockModelId, "example.ranker");
  assert.equal(config.embedModelId, "example.embedder");
  assert.equal(config.bedrockState, "live");
  assert.equal(config.bedrockRegion, "ap-south-1");
});
