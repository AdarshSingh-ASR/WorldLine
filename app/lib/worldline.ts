/**
 * The single boundary between the control room and the WORLDLINE agent.
 *
 * Every field rendered by the interface originates here. There is deliberately
 * no seeded scenario, no synthetic route and no simulated timer: if the agent
 * cannot be reached the caller receives an error and the interface renders an
 * unavailable state instead of inventing a world.
 */

/**
 * The published control room must always have a real agent to contact. Local
 * development can override this with NEXT_PUBLIC_WORLDLINE_API_URL in .env.
 */
const PUBLIC_AGENT_URL = "https://m1gira53f9.execute-api.us-east-1.amazonaws.com";

export const API_BASE = (
  process.env.NEXT_PUBLIC_WORLDLINE_API_URL ?? PUBLIC_AGENT_URL
).replace(/\/$/, "");

/* ------------------------------------------------------------------ types */

export type RegionState = "connected" | "disconnected";

export type RegionHealth = {
  region: string;
  primary: boolean;
  zones: string[] | null;
  state: RegionState;
  lastEvent: {
    state: string;
    checkedHlc: string;
    createdAt: string;
    survivingRegions: string[];
  } | null;
};

export type RegionReport = {
  multiRegion: boolean;
  survivalGoal: string | null;
  regions: RegionHealth[];
  observedAt: string;
};

export type Health = {
  ok: boolean;
  mode: "live" | "demo";
  memoryPlane: string;
  region?: string;
  bedrock?: { rankingModel: string; embeddingModel: string; state: string };
  database?:
    | string
    | {
        checked_at: string;
        version: string;
        database_name: string;
        regions: Array<Record<string, unknown>>;
        cdc: { last_observed_at: string | null; confirmation_count: number };
      };
};

export type SafetyResult = {
  valid: boolean;
  achievedSeparationM: number;
  batteryAfterPct: number;
  checks: Record<string, boolean>;
};

export type Maneuver = {
  id: string;
  label: string;
  altitudeDeltaM: number;
  timeDeltaS: number;
  energyCostPct: number;
  memoryId?: string | null;
  causalReason?: string | null;
};

export type MemoryRow = {
  id: string;
  title: string;
  scenario: Record<string, unknown> | null;
  maneuverId: string;
  maneuver: Record<string, unknown> | null;
  outcome: string;
  confidence: number;
  occurredAt: string;
  similarity: number;
};

export type CommittedRoute = {
  routeId: string;
  decisionId: string;
  receiptId: string;
  corridorId: string;
  decisionHlc: string;
  useAlternate: boolean;
  safety: SafetyResult;
  agentId: string;
  homeRegion: string;
  maneuverId: string;
  maneuverLabel: string;
  selectedMemoryId: string | null;
  cells: string[];
  state: string;
  retryCount: number;
};

export type Scenario = {
  id: string;
  description: string;
  homeRegion: string;
  vehicleClass: string;
  batteryPct: number;
  minimumSeparationM: number;
};

export type RaceResult = {
  runId: string;
  receiptId: string;
  decisionHlc: string;
  similarity: number;
  memoryId: string;
  memoryOccurredAt: string | null;
  maneuver: string;
  maneuverId: string;
  selectedManeuver?: Maneuver;
  causalReason: string | null;
  retryCount: number;
  cdcConfirmed: boolean;
  mode: "live" | "demo";
  scenario?: Scenario;
  memories?: MemoryRow[];
  routes: CommittedRoute[];
  rejected?: boolean;
  safety?: SafetyResult;
  /** Set by the agent when WORLDLINE_DEMO_FALLBACK fabricated the response. */
  synthetic?: boolean;
  idempotentReplay?: boolean;
  providers?: { embedding: string; ranking: string };
};

export type AgentIdentity = {
  id: string;
  homeRegion: string;
  role: string;
};

export type Corridor = {
  corridor_id: string;
  capacity: number;
  used: number;
  revision: number;
  home_region: string;
  updated_at: string;
};

export type Briefing = {
  scenario: Scenario;
  agents: AgentIdentity[];
  maneuverCandidates: Maneuver[];
  corridors: Corridor[];
  policy: {
    id: string;
    version: string;
    state: string;
    rules: Record<string, unknown>;
  } | null;
  airspaceCells: Array<{
    id: string;
    home_region: string;
    altitude_floor_m: number;
    altitude_ceiling_m: number;
    state: string;
  }>;
  observedAt: string;
};

export type CdcEvent = {
  source_table: string;
  source_key: string;
  mvcc_timestamp: string;
  event_op: string;
  observed_at: string;
};

export type EventReport = {
  events: CdcEvent[];
  cursor: string | null;
  latestObservedAt: string | null;
  observedAt: string;
};

export type BrokerEvent = {
  broker_region: string;
  state: string;
  surviving_regions: string[];
  checked_hlc: string;
  created_at: string;
  commitmentPlane: string;
  databaseWriteVerified: boolean;
};

export type Receipt = Record<string, unknown> & {
  id: string;
  decision_hlc: string;
  content_hash: string;
  evidence: Record<string, unknown>;
  cdc_observed: boolean;
  archived: boolean;
  archive_key: string | null;
  asOf: string;
  worldSnapshot: Array<Record<string, unknown>>;
};

/* ----------------------------------------------------------------- client */

export class AgentUnavailableError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(message: string, status = 0, detail: string | null = null) {
    super(message);
    this.name = "AgentUnavailableError";
    this.status = status;
    this.detail = detail;
  }
}

function idempotencyKey(prefix: string) {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `worldline-web-${prefix}-${random}`;
}

async function call<T>(
  path: string,
  init: RequestInit & { idempotency?: string } = {},
): Promise<T> {
  const { idempotency, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (rest.method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("x-idempotency-key", idempotencyKey(idempotency ?? "op"));
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...rest, headers });
  } catch (error) {
    throw new AgentUnavailableError(
      `Cannot reach the WORLDLINE agent at ${API_BASE}`,
      0,
      error instanceof Error ? error.message : null,
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new AgentUnavailableError(
        `Agent returned a non-JSON response (${response.status})`,
        response.status,
        text.slice(0, 200),
      );
    }
  }

  if (!response.ok) {
    const record = (body ?? {}) as { error?: string; detail?: string };
    throw new AgentUnavailableError(
      record.error ?? `Agent request failed (${response.status})`,
      response.status,
      record.detail ?? null,
    );
  }

  return body as T;
}

export const agent = {
  health: (signal?: AbortSignal) => call<Health>("/health", { signal }),
  regions: (signal?: AbortSignal) => call<RegionReport>("/v1/regions", { signal }),
  briefing: (signal?: AbortSignal) => call<Briefing>("/v1/scenario", { signal }),
  world: (signal?: AbortSignal) =>
    call<{ asOf: string; routes: Array<Record<string, unknown>> }>("/v1/world", {
      signal,
    }),
  events: (since: string | null, signal?: AbortSignal) =>
    call<EventReport>(
      since ? `/v1/events?since=${encodeURIComponent(since)}` : "/v1/events",
      { signal },
    ),
  race: (memoryEnabled: boolean, signal?: AbortSignal) =>
    call<RaceResult>("/v1/demo/race", {
      method: "POST",
      body: JSON.stringify({ memoryEnabled }),
      idempotency: "race",
      signal,
    }),
  reset: (signal?: AbortSignal) =>
    call<{ reset: boolean }>("/v1/demo/reset", {
      method: "POST",
      body: JSON.stringify({}),
      idempotency: "reset",
      signal,
    }),
  receipt: (id: string, signal?: AbortSignal) =>
    call<Receipt>(`/v1/receipts/${encodeURIComponent(id)}`, { signal }),
  disconnectRegion: (region: string, signal?: AbortSignal) =>
    call<BrokerEvent>("/v1/demo/broker-failure", {
      method: "POST",
      body: JSON.stringify({ region }),
      idempotency: "broker-down",
      signal,
    }),
  recoverRegion: (region: string, signal?: AbortSignal) =>
    call<BrokerEvent>("/v1/demo/broker-recover", {
      method: "POST",
      body: JSON.stringify({ region }),
      idempotency: "broker-up",
      signal,
    }),
};

/* ------------------------------------------------------------ derivations */

/** Stable region identity. Every surface colours a region through this key. */
export function regionKey(region: string | null | undefined): string {
  if (!region) return "unknown";
  return region.replace(/^aws-/, "");
}

const REGION_LABELS: Record<string, string> = {
  "us-east-1": "US",
  "eu-west-1": "EU",
  "ap-south-1": "ASIA",
};

export function regionLabel(region: string | null | undefined): string {
  const key = regionKey(region);
  return REGION_LABELS[key] ?? key.toUpperCase();
}

/**
 * Assigns each region a slot so CSS can colour it consistently. Regions the
 * build does not know about still get a stable slot from their name, which
 * keeps the legend honest when the cluster topology changes.
 */
export function regionSlot(region: string | null | undefined): number {
  const key = regionKey(region);
  const known = ["us-east-1", "eu-west-1", "ap-south-1"].indexOf(key);
  if (known >= 0) return known;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 997;
  }
  return 3 + (hash % 3);
}

/** Relative age of a real timestamp. Returns null when there is no data. */
export function relativeAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  const units: Array<[number, string]> = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [604800, "day"],
    [2629800, "week"],
    [31557600, "month"],
  ];
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  for (let index = 1; index < units.length; index += 1) {
    const [limit, name] = units[index];
    if (seconds < limit) {
      const value = Math.round(seconds / units[index - 1][0]);
      return `${value} ${name}${value === 1 ? "" : "s"} ago`;
    }
  }
  const years = seconds / 31557600;
  return `${years.toFixed(1)} years ago`;
}

/**
 * Presents a memory's scenario JSONB without assuming its keys. Long prose is
 * separated from short facts, camelCase keys are humanised, and arrays are
 * joined — so a memory seeded with different fields still reads correctly.
 */
export function describeScenario(scenario: Record<string, unknown> | null): {
  prose: string | null;
  facts: Array<{ label: string; value: string }>;
} {
  if (!scenario) return { prose: null, facts: [] };
  let prose: string | null = null;
  const facts: Array<{ label: string; value: string }> = [];

  for (const [key, raw] of Object.entries(scenario)) {
    const value = Array.isArray(raw)
      ? raw.join(" / ")
      : raw === null || raw === undefined
        ? ""
        : String(raw);
    if (!value) continue;
    // Anything sentence-length is prose, not a fact chip.
    if (value.length > 48) {
      if (!prose) prose = value;
      continue;
    }
    facts.push({
      label: key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .toLowerCase(),
      value,
    });
  }

  return { prose, facts };
}

export function shortHlc(hlc: string | null | undefined): string {
  if (!hlc) return "—";
  const [seconds, logical] = String(hlc).split(",");
  if (!seconds) return String(hlc);
  return `${seconds.slice(0, 10)}…${seconds.slice(-4)}${logical ? `,${logical}` : ""}`;
}

/**
 * Derives the transaction log from the committed result. The entries below are
 * reconstructed from real fields — corridor ids, per-route retry counts and
 * HLC timestamps — because the serializable race itself runs inside a single
 * agent request and the browser cannot observe its intermediate states.
 */
export type LogEntry = {
  id: string;
  stream: "memory" | "txn" | "cdc" | "region" | "error";
  region: string | null;
  label: string;
  detail: string;
  state: "ok" | "retry" | "fail" | "info";
};

export function buildTransactionLog(result: RaceResult): LogEntry[] {
  const entries: LogEntry[] = [];
  const push = (entry: Omit<LogEntry, "id">) =>
    entries.push({ ...entry, id: `${entries.length}-${entry.label}` });

  const memories = result.memories ?? [];
  if (memories.length > 0) {
    const top = memories[0];
    push({
      stream: "memory",
      region: result.scenario?.homeRegion ?? null,
      label: "VECTOR RECALL",
      detail: `n=${memories.length} top=${top.id} cos=${Number(top.similarity).toFixed(4)}`,
      state: "ok",
    });
    push({
      stream: "memory",
      region: result.scenario?.homeRegion ?? null,
      label: "MANEUVER SELECTED",
      detail: `${result.maneuverId} from ${top.id} (${top.outcome})`,
      state: "ok",
    });
  } else {
    push({
      stream: "memory",
      region: result.scenario?.homeRegion ?? null,
      label: "VECTOR RECALL",
      detail: "n=0 memory disabled — counterfactual path",
      state: "info",
    });
  }

  for (const route of result.routes ?? []) {
    push({
      stream: "txn",
      region: route.homeRegion,
      label: `${route.agentId} BEGIN`,
      detail: `ISOLATION LEVEL SERIALIZABLE corridor=${route.corridorId}`,
      state: "info",
    });
    if (route.retryCount > 0) {
      push({
        stream: "error",
        region: route.homeRegion,
        label: `${route.agentId} RETRY_SERIALIZABLE`,
        detail: `SQLSTATE 40001 ×${route.retryCount} — re-read capacity, took ${route.maneuverId}`,
        state: "retry",
      });
    }
    push({
      stream: "txn",
      region: route.homeRegion,
      label: `${route.agentId} COMMITTED`,
      detail: `corridor=${route.corridorId} cells=${route.cells?.length ?? 0} sep=${route.safety?.achievedSeparationM ?? "?"}m hlc=${shortHlc(route.decisionHlc)}`,
      state: "ok",
    });
  }

  if (result.rejected) {
    push({
      stream: "error",
      region: result.scenario?.homeRegion ?? null,
      label: "ADMISSION REJECTED",
      detail: "no movement token issued — safety invariant held",
      state: "fail",
    });
  }

  if (result.receiptId && result.receiptId !== "NO-COMMIT") {
    push({
      stream: "cdc",
      region: null,
      label: result.cdcConfirmed ? "CDC OBSERVED" : "CDC PENDING",
      detail: `receipt=${result.receiptId.slice(0, 8)} hlc=${shortHlc(result.decisionHlc)}`,
      state: result.cdcConfirmed ? "ok" : "info",
    });
  }

  return entries;
}
