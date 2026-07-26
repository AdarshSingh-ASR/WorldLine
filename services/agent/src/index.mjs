import { z } from "zod";
import { loadConfig } from "./config.mjs";
import { createDatabase } from "./database.mjs";
import { archiveReceipt } from "./evidence.mjs";
import { chooseManeuver, validateSafety } from "./invariants.mjs";
import { WorldlineProviders } from "./providers.mjs";
import { scenario, WorldlineRepository } from "./repository.mjs";

const config = loadConfig();
const pool = createDatabase(config.databaseUrl);
const repository = pool ? new WorldlineRepository(pool) : null;
const providers = new WorldlineProviders(config);

const raceSchema = z.object({
  memoryEnabled: z.boolean().default(true),
});

function response(statusCode, body, origin = config.allowedOrigin) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "content-type,x-idempotency-key",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      vary: "origin",
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  return JSON.parse(event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body);
}

function fallbackRace(memoryEnabled = true) {
  const memory = {
    id: "MEM-2041",
    maneuverId: "MANEUVER-03",
    similarity: 0.94,
  };
  const maneuver = chooseManeuver({
    memoryEnabled,
    memories: memoryEnabled ? [memory] : [],
  });
  return {
    runId: "WL-2047",
    receiptId: "RCP-7F31A9",
    decisionHlc: "1785063718.442913000,2",
    similarity: memoryEnabled ? 94 : 0,
    memoryId: memoryEnabled ? memory.id : "NO-MEMORY",
    memoryAge: "6 weeks ago",
    maneuver: maneuver.label,
    retryCount: 1,
    cdcConfirmed: true,
    mode: "demo",
    safety: validateSafety({
      minimumSeparationM: 0,
      maneuver,
      batteryPct: 47,
    }),
  };
}

async function runRace(memoryEnabled) {
  if (!repository) {
    if (!config.demoFallback) throw new Error("WORLDLINE_DATABASE_URL is required");
    return fallbackRace(memoryEnabled);
  }
  const embedded = await providers.embedScenario(scenario.description);
  const memories = memoryEnabled
    ? await repository.retrieveMemories(embedded.vector)
    : [];
  const maneuver = await providers.rankManeuvers({
    scenario,
    memories,
    memoryEnabled,
  });
  const result = await repository.runRace({
    maneuver,
    memory: memories[0] ?? null,
    embeddingProvider: embedded.provider,
    plannerProvider: maneuver.provider,
  });
  await archiveReceipt(config, result).catch(() => {});
  return result;
}

export async function handler(event) {
  const origin = event.headers?.origin ?? config.allowedOrigin;
  if (event.requestContext?.http?.method === "OPTIONS") return response(204, {}, origin);
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const path = event.rawPath ?? event.path ?? "/";

  try {
    if (method === "GET" && path === "/health") {
      if (!repository) {
        return response(200, {
          ok: true,
          mode: "demo",
          database: "not-configured",
          memoryPlane: "deterministic",
        }, origin);
      }
      return response(200, {
        ok: true,
        mode: "live",
        database: await repository.health(),
        memoryPlane: "cockroachdb",
      }, origin);
    }

    if (method === "POST") {
      const idempotencyKey =
        event.headers?.["x-idempotency-key"] ??
        event.headers?.["X-Idempotency-Key"];
      if (!idempotencyKey) {
        return response(400, { error: "x-idempotency-key is required" }, origin);
      }
    }

    if (method === "POST" && path === "/v1/demo/reset") {
      return response(
        200,
        repository ? await repository.resetDemo() : { reset: true, mode: "demo" },
        origin,
      );
    }

    if (method === "POST" && path === "/v1/demo/race") {
      const input = raceSchema.parse(parseBody(event));
      return response(200, await runRace(input.memoryEnabled), origin);
    }

    if (method === "POST" && path === "/v1/routes/plan") {
      const input = raceSchema.parse(parseBody(event));
      if (!repository) {
        return response(200, fallbackRace(input.memoryEnabled), origin);
      }
      const embedded = await providers.embedScenario(scenario.description);
      const memories = input.memoryEnabled
        ? await repository.retrieveMemories(embedded.vector)
        : [];
      const maneuver = await providers.rankManeuvers({
        scenario,
        memories,
        memoryEnabled: input.memoryEnabled,
      });
      return response(200, {
        scenario,
        memories,
        maneuver,
        safety: validateSafety({
          minimumSeparationM: 0,
          maneuver,
          batteryPct: scenario.batteryPct,
        }),
      }, origin);
    }

    if (method === "GET" && path === "/v1/world") {
      if (!repository) return response(200, { asOf: "demo", routes: [] }, origin);
      return response(
        200,
        await repository.getWorld(event.queryStringParameters?.as_of),
        origin,
      );
    }

    const receiptMatch = path.match(/^\/v1\/receipts\/([a-zA-Z0-9-]+)$/);
    if (method === "GET" && receiptMatch) {
      if (!repository) return response(200, fallbackRace(true), origin);
      const receipt = await repository.getReceipt(receiptMatch[1]);
      return receipt
        ? response(200, receipt, origin)
        : response(404, { error: "Receipt not found" }, origin);
    }

    const commitMatch = path.match(/^\/v1\/routes\/([a-zA-Z0-9-]+)\/(commit|extend)$/);
    if (method === "POST" && commitMatch) {
      return response(
        202,
        {
          routeId: commitMatch[1],
          operation: commitMatch[2],
          state: "accepted",
          message: "Use the typed planner and serializable admission path.",
        },
        origin,
      );
    }

    return response(404, { error: "Not found" }, origin);
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    return response(
      status,
      {
        error: status === 400 ? "Invalid request" : "WORLDLINE operation failed",
        detail: error.message,
        code: error.code ?? null,
      },
      origin,
    );
  }
}

export { runRace };
