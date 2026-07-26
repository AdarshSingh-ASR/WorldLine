import assert from "node:assert/strict";
import { runRace } from "../src/index.mjs";

const result = await runRace(true);
assert.equal(result.memoryId, "MEM-2041");
assert.match(result.maneuver, /Vertical separation/i);
assert.ok(result.retryCount >= 0);
assert.ok(result.decisionHlc);
console.log(JSON.stringify(result, null, 2));
