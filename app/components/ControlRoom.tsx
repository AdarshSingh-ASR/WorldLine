"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import AirspaceViewport, { type ViewportPhase } from "./AirspaceViewport";
import ReceiptDrawer from "./ReceiptDrawer";
import {
  API_BASE,
  AgentUnavailableError,
  agent,
  buildTransactionLog,
  describeScenario,
  regionKey,
  regionLabel,
  regionSlot,
  relativeAge,
  shortHlc,
  type Briefing,
  type Health,
  type LogEntry,
  type RaceResult,
  type Receipt,
  type RegionReport,
} from "../lib/worldline";

type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: AgentUnavailableError };

function errorOf(error: unknown): AgentUnavailableError {
  return error instanceof AgentUnavailableError
    ? error
    : new AgentUnavailableError(
        error instanceof Error ? error.message : "Unknown failure",
      );
}

export default function ControlRoom() {
  const [health, setHealth] = useState<Loadable<Health>>({ status: "loading" });
  const [briefing, setBriefing] = useState<Loadable<Briefing>>({
    status: "loading",
  });
  const [regions, setRegions] = useState<Loadable<RegionReport>>({
    status: "loading",
  });

  const [result, setResult] = useState<RaceResult | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRegion, setPendingRegion] = useState<string | null>(null);

  const [log, setLog] = useState<LogEntry[]>([]);
  const [cdcCount, setCdcCount] = useState<number | null>(null);
  const [feedState, setFeedState] = useState<"idle" | "live" | "stalled">("idle");
  const [lastFeedAt, setLastFeedAt] = useState<string | null>(null);

  const cursorRef = useRef<string | null>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const seenEventsRef = useRef(new Set<string>());

  /* --------------------------------------------------------- preferences */

  /**
   * Subscribed rather than copied into state, so the preference is read from
   * the platform and never falls out of sync. The server snapshot is `false`
   * because the preference is unknowable until hydration.
   */
  const reducedMotion = useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );

  const appendLog = useCallback((entries: LogEntry[]) => {
    if (entries.length === 0) return;
    setLog((current) => {
      const next = [...current, ...entries];
      return next.slice(-160);
    });
  }, []);

  /* ------------------------------------------------------------- loaders */

  const loadRegions = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await agent.regions(signal);
      setRegions({ status: "ready", value });
      return value;
    } catch (error) {
      if (signal?.aborted) return null;
      setRegions({ status: "error", error: errorOf(error) });
      return null;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    void (async () => {
      const [healthResult, briefingResult] = await Promise.allSettled([
        agent.health(signal),
        agent.briefing(signal),
      ]);
      if (signal.aborted) return;

      if (healthResult.status === "fulfilled") {
        setHealth({ status: "ready", value: healthResult.value });
      } else {
        setHealth({ status: "error", error: errorOf(healthResult.reason) });
      }

      if (briefingResult.status === "fulfilled") {
        setBriefing({ status: "ready", value: briefingResult.value });
      } else {
        setBriefing({ status: "error", error: errorOf(briefingResult.reason) });
      }

      await loadRegions(signal);
    })();

    return () => controller.abort();
  }, [loadRegions]);

  /* ------------------------------------------- real changefeed activity */

  useEffect(() => {
    if (health.status !== "ready" || health.value.mode !== "live") return;
    let stopped = false;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const report = await agent.events(cursorRef.current, controller.signal);
        if (stopped) return;
        const firstPoll = cursorRef.current === null;
        cursorRef.current = report.cursor ?? cursorRef.current;
        setLastFeedAt(report.observedAt);

        const fresh = report.events.filter((event) => {
          const key = `${event.source_table}:${event.source_key}:${event.mvcc_timestamp}`;
          if (seenEventsRef.current.has(key)) return false;
          seenEventsRef.current.add(key);
          return true;
        });

        // The first poll returns the existing tail of an append-only table, so
        // it seeds the cursor without being reported as live activity.
        if (firstPoll) {
          setFeedState("idle");
          return;
        }

        setCdcCount((previous) => (previous ?? 0) + fresh.length);

        // "live" means the database genuinely produced new CDC rows. A quiet
        // poll leaves the previous verdict alone rather than inventing motion.
        if (fresh.length > 0) setFeedState("live");
        else setFeedState((previous) => (previous === "stalled" ? "idle" : previous));

        appendLog(
          fresh.map((event, index) => ({
            id: `cdc-${event.mvcc_timestamp}-${index}`,
            stream: "cdc" as const,
            region: null,
            label: `CDC ${event.event_op.toUpperCase()}`,
            detail: `${event.source_table} key=${String(event.source_key).slice(0, 8)} mvcc=${shortHlc(event.mvcc_timestamp)}`,
            state: "ok" as const,
          })),
        );
      } catch {
        if (!stopped && !controller.signal.aborted) {
          setFeedState("stalled");
        }
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [health, appendLog]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [log]);

  /* ------------------------------------------------------------- actions */

  const commitBothFutures = useCallback(async () => {
    if (committing) return;
    setCommitting(true);
    setActionError(null);
    setReceipt(null);
    setReceiptError(null);
    appendLog([
      {
        id: `run-${Date.now()}`,
        stream: "txn",
        region: null,
        label: "ADMISSION REQUESTED",
        detail: `POST /v1/demo/race memoryEnabled=${memoryEnabled}`,
        state: "info",
      },
    ]);

    try {
      const value = await agent.race(memoryEnabled);
      if (value.synthetic) {
        throw new AgentUnavailableError(
          "Agent returned a synthetic response",
          200,
          "WORLDLINE_DEMO_FALLBACK is enabled. Point the agent at a CockroachDB cluster; the control room will not present fabricated state as a commit.",
        );
      }
      setResult(value);
      appendLog(buildTransactionLog(value));
      // Refresh topology in the background. Reading cluster regions is a
      // multi-second call on a three-region cluster, and blocking on it here
      // would leave the control reading "Committing…" after the futures are
      // already committed.
      void loadRegions();
    } catch (error) {
      const failure = errorOf(error);
      setActionError(failure.detail ?? failure.message);
      appendLog([
        {
          id: `err-${Date.now()}`,
          stream: "error",
          region: null,
          label: "ADMISSION FAILED",
          detail: `${failure.message}${failure.detail ? ` — ${failure.detail}` : ""}`,
          state: "fail",
        },
      ]);
    } finally {
      setCommitting(false);
    }
  }, [committing, memoryEnabled, appendLog, loadRegions]);

  const resetWorld = useCallback(async () => {
    setActionError(null);
    try {
      await agent.reset();
      setResult(null);
      setReceipt(null);
      setReceiptOpen(false);
      appendLog([
        {
          id: `reset-${Date.now()}`,
          stream: "txn",
          region: null,
          label: "CORRIDOR CAPACITY RESET",
          detail: "POST /v1/demo/reset",
          state: "info",
        },
      ]);
      await loadRegions();
    } catch (error) {
      setActionError(errorOf(error).message);
    }
  }, [appendLog, loadRegions]);

  const toggleRegion = useCallback(
    async (region: string, currently: string) => {
      setPendingRegion(region);
      setActionError(null);
      try {
        const event =
          currently === "disconnected"
            ? await agent.recoverRegion(region)
            : await agent.disconnectRegion(region);
        appendLog([
          {
            id: `broker-${Date.now()}`,
            stream: "region",
            region,
            label: `BROKER ${String(event.state).toUpperCase()}`,
            detail: `${event.broker_region} surviving=[${(event.surviving_regions ?? []).map(regionLabel).join(" ")}] hlc=${shortHlc(event.checked_hlc)}`,
            state: event.state === "disconnected" ? "retry" : "ok",
          },
        ]);
        // The broker event is already committed; reflect the new topology
        // without holding the control in a pending state while it loads.
        void loadRegions();
      } catch (error) {
        setActionError(errorOf(error).message);
      } finally {
        setPendingRegion(null);
      }
    },
    [appendLog, loadRegions],
  );

  const openReceipt = useCallback(async () => {
    if (!result?.receiptId || result.receiptId === "NO-COMMIT") return;
    setReceiptOpen(true);
    setReceiptError(null);
    try {
      setReceipt(await agent.receipt(result.receiptId));
    } catch (error) {
      setReceiptError(errorOf(error).message);
    }
  }, [result]);

  /* -------------------------------------------------------- derived view */

  const backendDown =
    health.status === "error" ||
    (health.status === "ready" && health.value.mode !== "live");

  const phase: ViewportPhase = backendDown
    ? "unavailable"
    : health.status === "loading" || briefing.status === "loading"
      ? "loading"
      : result
        ? "resolved"
        : committing
          ? "committing"
          : "briefed";

  const offlineRegions = useMemo(
    () =>
      regions.status === "ready"
        ? regions.value.regions
            .filter((region) => region.state === "disconnected")
            .map((region) => regionKey(region.region))
        : [],
    [regions],
  );

  const memories = result?.memories ?? [];
  const topMemory = memories[0] ?? null;
  const alternateRoute = result?.routes.find((route) => route.useAlternate) ?? null;
  const cdcConfirmed = Boolean(result?.cdcConfirmed);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      }
      if (event.key.toLowerCase() === "c" && !backendDown) {
        event.preventDefault();
        void commitBothFutures();
      }
      if (event.key.toLowerCase() === "r" && !backendDown) {
        event.preventDefault();
        void resetWorld();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [backendDown, commitBothFutures, resetWorld]);

  /* ---------------------------------------------------------------- view */

  return (
    <main className="console" data-phase={phase}>
      <header className="console-head">
        <div className="identity">
          <img
            className="sigil"
            src="/brand/worldline-mark.svg"
            alt=""
            aria-hidden="true"
          />
          <div>
            <h1>WORLDLINE</h1>
            <p>Commitment plane · corridor {briefing.status === "ready" ? briefing.value.scenario.id : "—"}</p>
          </div>
        </div>

        <div className="head-status" role="status">
          <span className={`beacon ${backendDown ? "down" : feedState}`} aria-hidden="true" />
          <span className="mono">
            {health.status === "loading"
              ? "CONNECTING"
              : health.status === "error"
                ? "AGENT UNREACHABLE"
                : backendDown
                  ? "NO DATABASE CONFIGURED"
                  : feedState === "stalled"
                    ? "CDC FEED STALLED"
                    : "MEMORY PLANE LIVE"}
          </span>
          <span className="divider" aria-hidden="true" />
          <span className="mono dim">
            CDC +{cdcCount ?? 0} OBSERVED
          </span>
          {lastFeedAt ? (
            <span className="mono dim">
              POLLED {new Date(lastFeedAt).toISOString().slice(11, 19)}Z
            </span>
          ) : null}
        </div>

        <div className="head-meta mono dim">
          <span>{API_BASE.replace(/^https?:\/\//, "")}</span>
        </div>
      </header>

      {backendDown ? (
        <section className="unavailable" role="alert">
          <h2>No authoritative world state</h2>
          <p>
            The control room renders committed CockroachDB state only. It will
            not display a simulated airspace.
          </p>
          <dl className="mono">
            <div>
              <dt>Agent</dt>
              <dd>{API_BASE}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>
                {health.status === "error"
                  ? (health.error.detail ?? health.error.message)
                  : "agent reachable but reported mode != live (no database configured)"}
              </dd>
            </div>
          </dl>
          <p className="hint">
            Start the agent with a CockroachDB connection:
            <code>cd services/agent &amp;&amp; npm run migrate &amp;&amp; npm run seed &amp;&amp; npm run dev</code>
          </p>
        </section>
      ) : null}

      {/* Not aria-hidden: every control inside is disabled while the agent is
          unavailable, and hiding a region that still contains focusable
          elements is worse for assistive technology than labelling it. */}
      <div className="console-body" data-degraded={backendDown ? "true" : undefined}>
        <section className="viewport-panel">
          <div className="viewport-head">
            <div>
              <span className="eyebrow">PREDICTED AIRSPACE</span>
              <h2>
                {result
                  ? "Committed futures"
                  : "Two agents. One physical world."}
              </h2>
            </div>
            <ul className="legend mono">
              {(briefing.status === "ready" ? briefing.value.agents : []).map(
                (identity) => (
                  <li key={identity.id} data-region={regionSlot(identity.homeRegion)}>
                    <i aria-hidden="true" />
                    {identity.id} · {regionLabel(identity.homeRegion)}
                  </li>
                ),
              )}
              <li data-state="conflict">
                <i aria-hidden="true" />
                CONTESTED
              </li>
              <li data-state="committed">
                <i aria-hidden="true" />
                COMMITTED
              </li>
            </ul>
          </div>

          <div className="viewport-frame">
            <AirspaceViewport
              phase={phase}
              briefing={briefing.status === "ready" ? briefing.value : null}
              result={result}
              reducedMotion={reducedMotion}
              cdcConfirmed={cdcConfirmed}
              offlineRegions={offlineRegions}
            />
            {briefing.status === "ready" && !result ? (
              <p className="viewport-note mono">
                {briefing.value.scenario.description}
                <br />
                <span className="dim">
                  minimum separation {briefing.value.scenario.minimumSeparationM} m ·
                  required {briefing.value.policy?.version ?? "policy"} · battery{" "}
                  {briefing.value.scenario.batteryPct}%
                </span>
              </p>
            ) : null}
            {result && alternateRoute ? (
              <p className="viewport-note mono committed">
                {alternateRoute.agentId} displaced to {alternateRoute.corridorId} ·{" "}
                {alternateRoute.safety?.achievedSeparationM} m separation ·{" "}
                {alternateRoute.cells?.length ?? 0} exclusion cells
              </p>
            ) : null}
          </div>

          <div className="viewport-controls">
            <button
              type="button"
              className="primary"
              onClick={() => void commitBothFutures()}
              disabled={committing || backendDown}
            >
              <span className="mono key">C</span>
              {committing ? "Committing…" : "Commit both futures"}
            </button>
            <button
              type="button"
              onClick={() => void resetWorld()}
              disabled={committing || backendDown}
            >
              <span className="mono key">R</span>
              Reset capacity
            </button>
            <label className="switch">
              <input
                type="checkbox"
                checked={memoryEnabled}
                onChange={(event) => setMemoryEnabled(event.target.checked)}
                disabled={committing || backendDown}
              />
              <span>
                Episodic memory
                <small className="dim">off = counterfactual</small>
              </span>
            </label>
            <button
              type="button"
              onClick={() => void openReceipt()}
              disabled={!result?.receiptId || result.receiptId === "NO-COMMIT"}
            >
              Commit receipt
            </button>
          </div>

          {actionError ? (
            <p className="inline-error mono" role="alert">
              {actionError}
            </p>
          ) : null}
        </section>

        <aside className="rail">
          {/* ------------------------------------------ region health */}
          <section className="rail-block">
            <div className="rail-head">
              <span className="eyebrow">REGION HEALTH</span>
              {regions.status === "ready" && regions.value.survivalGoal ? (
                <span className="mono dim">
                  {regions.value.survivalGoal.replace(/_/g, " ")}
                </span>
              ) : null}
            </div>

            {regions.status === "loading" ? (
              <p className="mono dim">reading cluster topology…</p>
            ) : regions.status === "error" ? (
              <p className="mono error-text">
                {regions.error.detail ?? regions.error.message}
              </p>
            ) : regions.value.regions.length === 0 ? (
              <p className="mono dim">
                cluster reports no database regions — run migrate with
                WORLDLINE_APPLY_MULTI_REGION=true
              </p>
            ) : (
              <ul className="regions">
                {regions.value.regions.map((region) => {
                  const key = regionKey(region.region);
                  return (
                    <li
                      key={region.region}
                      data-region={regionSlot(region.region)}
                      data-state={region.state}
                    >
                      <span className="region-dot" aria-hidden="true" />
                      <span className="region-name mono">
                        {regionLabel(region.region)}
                        {region.primary ? <b title="primary region">*</b> : null}
                      </span>
                      <span className="region-state mono">
                        {region.state === "disconnected" ? "OFFLINE" : "ONLINE"}
                      </span>
                      <button
                        type="button"
                        className="ghost mono"
                        onClick={() => void toggleRegion(key, region.state)}
                        disabled={pendingRegion === key || backendDown}
                      >
                        {pendingRegion === key
                          ? "…"
                          : region.state === "disconnected"
                            ? "RECONNECT"
                            : "DISCONNECT"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ------------------------------------------ episodic memory */}
          <section className="rail-block grow-1">
            <div className="rail-head">
              <span className="eyebrow">EPISODIC MEMORY</span>
              <span className="mono dim">
                {result ? `n=${memories.length}` : "awaiting recall"}
              </span>
            </div>

            {!result ? (
              <p className="mono dim">
                Vector recall runs inside the admission request. Commit to
                retrieve.
              </p>
            ) : memories.length === 0 ? (
              <p className="mono dim">
                No memory retrieved — counterfactual path. The maneuver was
                selected without episodic recall.
              </p>
            ) : (
              <>
                <article className="memory-primary">
                  <header>
                    <span className="mono">{topMemory?.id}</span>
                    <span className="mono dim">
                      {relativeAge(topMemory?.occurredAt) ?? "—"}
                    </span>
                  </header>
                  <div className="similarity">
                    <strong className="mono">
                      {(Number(topMemory?.similarity ?? 0) * 100).toFixed(1)}
                      <small>%</small>
                    </strong>
                    <span>
                      cosine similarity
                      <small className="dim">
                        prefix: {regionLabel(result.scenario?.homeRegion)} ·{" "}
                        {result.scenario?.vehicleClass}
                      </small>
                    </span>
                  </div>
                  <h3>{topMemory?.title}</h3>
                  {(() => {
                    const { prose, facts } = describeScenario(
                      topMemory?.scenario ?? null,
                    );
                    return (
                      <>
                        {prose ? <p className="memory-prose">{prose}</p> : null}
                        {facts.length > 0 ? (
                          <dl className="memory-facts mono">
                            {facts.map((fact) => (
                              <div key={fact.label}>
                                <dt>{fact.label}</dt>
                                <dd title={fact.value}>{fact.value}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                      </>
                    );
                  })()}
                  <footer>
                    <span className="mono">
                      outcome: {topMemory?.outcome}
                    </span>
                    <span className="mono dim">
                      confidence {Number(topMemory?.confidence ?? 0).toFixed(2)}
                    </span>
                  </footer>
                </article>

                <div className="causal mono">
                  <span>{topMemory?.id}</span>
                  <i aria-hidden="true">→</i>
                  <span>{result.maneuverId}</span>
                  <i aria-hidden="true">→</i>
                  <span>{alternateRoute?.agentId ?? "—"}</span>
                </div>
                {result.causalReason ? (
                  <p className="causal-reason">{result.causalReason}</p>
                ) : null}

                {memories.length > 1 ? (
                  <ul className="memory-rejected mono">
                    {memories.slice(1).map((memory) => (
                      <li key={memory.id}>
                        <span className="dim">considered</span> {memory.id} ·{" "}
                        {(Number(memory.similarity) * 100).toFixed(1)}% ·{" "}
                        {memory.maneuverId}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </section>

          {/* ------------------------------------------ transaction log */}
          <section className="rail-block grow-2">
            <div className="rail-head">
              <span className="eyebrow">TRANSACTION LOG</span>
              <span className="mono dim">{log.length} entries</span>
            </div>
            {log.length === 0 ? (
              <p className="mono dim">no admissions yet</p>
            ) : (
              <ol className="txn-log mono" ref={logRef} aria-live="polite">
                {log.map((entry) => (
                  <li
                    key={entry.id}
                    data-stream={entry.stream}
                    data-state={entry.state}
                    data-region={entry.region ? regionSlot(entry.region) : undefined}
                  >
                    <span className="txn-label">{entry.label}</span>
                    <span className="txn-detail">{entry.detail}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* ------------------------------------------ provider status */}
          {health.status === "ready" && health.value.bedrock ? (
            <section className="rail-block">
              <div className="rail-head">
                <span className="eyebrow">PROVIDERS</span>
              </div>
              <dl className="kv mono">
                <div>
                  <dt>embedding</dt>
                  <dd>
                    {result?.providers?.embedding ??
                      health.value.bedrock.embeddingModel}
                  </dd>
                </div>
                <div>
                  <dt>ranking</dt>
                  <dd>
                    {result?.providers?.ranking ??
                      health.value.bedrock.rankingModel}
                  </dd>
                </div>
              </dl>
            </section>
          ) : null}
        </aside>
      </div>

      <ReceiptDrawer
        open={receiptOpen}
        receipt={receipt}
        error={receiptError}
        result={result}
        onClose={() => setReceiptOpen(false)}
      />
    </main>
  );
}
