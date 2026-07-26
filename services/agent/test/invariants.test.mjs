import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateClaims,
  chooseManeuver,
  deterministicVector,
  validateHlc,
  validateSafety,
} from "../src/invariants.mjs";

test("episodic memory causally selects vertical separation", () => {
  const withMemory = chooseManeuver({
    memoryEnabled: true,
    memories: [{ id: "MEM-2041", maneuverId: "MANEUVER-03" }],
  });
  const withoutMemory = chooseManeuver({ memoryEnabled: false, memories: [] });
  assert.equal(withMemory.id, "MANEUVER-03");
  assert.equal(withMemory.memoryId, "MEM-2041");
  assert.notEqual(withoutMemory.id, withMemory.id);
});

test("exact safety validation remains authoritative", () => {
  const maneuver = chooseManeuver({
    memoryEnabled: true,
    memories: [{ id: "MEM-2041", maneuverId: "MANEUVER-03" }],
  });
  assert.equal(
    validateSafety({
      minimumSeparationM: 0,
      maneuver,
      batteryPct: 47,
    }).valid,
    true,
  );
  assert.equal(
    validateSafety({
      minimumSeparationM: 0,
      maneuver: { ...maneuver, altitudeDeltaM: 8 },
      batteryPct: 47,
    }).valid,
    false,
  );
});

test("one hundred agents cannot double-claim an exclusion slot", () => {
  const requests = Array.from({ length: 100 }, (_, index) => ({
    id: `agent-${index}`,
    cellId: "X17-03",
    slotStart: "T+15",
  }));
  const results = allocateClaims(requests);
  assert.equal(results.filter((result) => result.committed).length, 1);
  assert.equal(results.filter((result) => !result.committed).length, 99);
});

test("deterministic vector has the Titan-compatible dimension", () => {
  const vector = deterministicVector("worldline memory");
  assert.equal(vector.length, 1024);
  assert.ok(vector.every(Number.isFinite));
});

test("HLC validation rejects SQL fragments", () => {
  assert.equal(validateHlc("1785063718442913000.0000000002"), "1785063718442913000.0000000002");
  assert.throws(() => validateHlc("now(); DROP TABLE routes"), (error) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
});
