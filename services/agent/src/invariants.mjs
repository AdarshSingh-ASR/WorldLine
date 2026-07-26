import { createHash } from "node:crypto";

export const maneuvers = [
  {
    id: "MANEUVER-03",
    label: "Vertical separation / +38 m",
    altitudeDeltaM: 38,
    timeDeltaS: 0,
    energyCostPct: 3.2,
  },
  {
    id: "MANEUVER-07",
    label: "Temporal hold / +11 s",
    altitudeDeltaM: 0,
    timeDeltaS: 11,
    energyCostPct: 2.1,
  },
  {
    id: "MANEUVER-11",
    label: "Lateral bypass / east 52 m",
    altitudeDeltaM: 4,
    timeDeltaS: 6,
    energyCostPct: 5.8,
  },
];

export function deterministicVector(text, dimensions = 1024) {
  const values = new Array(dimensions).fill(0);
  const features = String(text)
    .toLowerCase()
    .match(/[a-z0-9]+(?:\.[0-9]+)?/g) ?? [];
  for (const feature of features) {
    const digest = createHash("sha256").update(feature).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const direction = (digest[4] & 1) === 0 ? 1 : -1;
    values[index] += direction;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0)) || 1;
  return values.map((value) => Number((value / norm).toFixed(6)));
}

export function vectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

export function chooseManeuver({ memoryEnabled, memories = [] }) {
  if (memoryEnabled && memories.some((memory) => memory.maneuverId === "MANEUVER-03")) {
    return {
      ...maneuvers[0],
      memoryId: memories.find((memory) => memory.maneuverId === "MANEUVER-03").id,
      causalReason:
        "A verified near-miss with matching merge geometry resolved safely through vertical separation.",
    };
  }
  return {
    ...maneuvers[1],
    memoryId: null,
    causalReason: "Deterministic emergency hold selected without episodic recall.",
  };
}

export function validateSafety({ minimumSeparationM, maneuver, batteryPct }) {
  const achievedSeparationM = minimumSeparationM + Math.abs(maneuver.altitudeDeltaM);
  const valid =
    achievedSeparationM >= 30 &&
    batteryPct - maneuver.energyCostPct >= 20 &&
    maneuver.timeDeltaS <= 15;
  return {
    valid,
    achievedSeparationM,
    batteryAfterPct: Number((batteryPct - maneuver.energyCostPct).toFixed(1)),
    checks: {
      separation: achievedSeparationM >= 30,
      batteryReserve: batteryPct - maneuver.energyCostPct >= 20,
      temporalBound: maneuver.timeDeltaS <= 15,
    },
  };
}

export function allocateClaims(requests) {
  const claims = new Map();
  const results = [];
  for (const request of requests) {
    const key = `${request.cellId}:${request.slotStart}`;
    if (claims.has(key)) {
      results.push({ ...request, committed: false, conflictWith: claims.get(key) });
    } else {
      claims.set(key, request.id);
      results.push({ ...request, committed: true, conflictWith: null });
    }
  }
  return results;
}

export function validateHlc(value) {
  if (!/^\d{16,22}(?:\.\d{1,10})?(?:,\d+)?$/.test(String(value))) {
    throw new Error("Invalid CockroachDB HLC timestamp");
  }
  return String(value);
}
