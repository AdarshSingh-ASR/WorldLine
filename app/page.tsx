"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Phase =
  | "ready"
  | "forecast"
  | "recalling"
  | "race"
  | "rerouting"
  | "rejected"
  | "committed"
  | "failure"
  | "receipt";

type RaceResult = {
  runId: string;
  receiptId: string;
  decisionHlc: string;
  similarity: number;
  memoryId: string;
  memoryAge: string;
  maneuver: string;
  retryCount: number;
  cdcConfirmed: boolean;
  mode: "live" | "demo";
  rejected?: boolean;
};

const DEFAULT_API_BASE = "https://m1gira53f9.execute-api.us-east-1.amazonaws.com";
const DEFAULT_WEBSOCKET_URL =
  "wss://nnzbzczagl.execute-api.us-east-1.amazonaws.com/live";
const API_BASE =
  process.env.NEXT_PUBLIC_WORLDLINE_API_URL?.replace(/\/$/, "") ??
  DEFAULT_API_BASE;
const WEBSOCKET_URL =
  process.env.NEXT_PUBLIC_WORLDLINE_WEBSOCKET_URL?.replace(/\/$/, "") ??
  DEFAULT_WEBSOCKET_URL;

const fallbackResult: RaceResult = {
  runId: "WL-2047",
  receiptId: "RCP-7F31A9",
  decisionHlc: "1785063718.442913000,2",
  similarity: 94,
  memoryId: "MEM-2041",
  memoryAge: "6 weeks ago",
  maneuver: "Vertical separation / +38 m",
  retryCount: 1,
  cdcConfirmed: true,
  mode: "demo",
};

const steps: Array<{ id: Phase; label: string }> = [
  { id: "forecast", label: "Forecast" },
  { id: "recalling", label: "Recall" },
  { id: "race", label: "Commit race" },
  { id: "rerouting", label: "Replan" },
  { id: "committed", label: "Execute" },
];

const phaseOrder: Phase[] = [
  "ready",
  "forecast",
  "recalling",
  "race",
  "rerouting",
  "rejected",
  "committed",
  "failure",
  "receipt",
];

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function phaseAtLeast(current: Phase, target: Phase) {
  return phaseOrder.indexOf(current) >= phaseOrder.indexOf(target);
}

function WorldlineCanvas({
  phase,
  reducedMotion,
  authoritative,
  memoryEnabled,
}: {
  phase: Phase;
  reducedMotion: boolean;
  authoritative: boolean;
  memoryEnabled: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let animationFrame = 0;
    let startedAt = performance.now();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(rect.width * ratio);
      canvas.height = Math.floor(rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      startedAt = performance.now();
    };

    const project = (
      x: number,
      y: number,
      z: number,
      width: number,
      height: number,
    ) => {
      const scale = Math.min(width, height) * 0.29;
      return {
        x: width * 0.5 + x * scale + z * scale * 0.44,
        y: height * 0.7 - y * scale - z * scale * 0.28,
      };
    };

    const polyline = (
      points: Array<[number, number, number]>,
      width: number,
      height: number,
      color: string,
      lineWidth: number,
      dash: number[] = [],
      glow = 0,
      progress = 1,
    ) => {
      const count = Math.max(2, Math.ceil(points.length * progress));
      context.save();
      context.beginPath();
      context.setLineDash(dash);
      context.lineWidth = lineWidth;
      context.strokeStyle = color;
      context.shadowColor = color;
      context.shadowBlur = glow;
      points.slice(0, count).forEach(([x, y, z], index) => {
        const point = project(x, y, z, width, height);
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.stroke();
      context.restore();
    };

    const routeA: Array<[number, number, number]> = [
      [-1.55, 0.15, -0.85],
      [-1.2, 0.22, -0.62],
      [-0.85, 0.3, -0.42],
      [-0.45, 0.38, -0.2],
      [0, 0.44, 0],
      [0.45, 0.48, 0.2],
      [0.9, 0.5, 0.42],
      [1.45, 0.54, 0.68],
    ];
    const unsafeB: Array<[number, number, number]> = [
      [1.45, 0.2, -0.82],
      [1.12, 0.27, -0.62],
      [0.76, 0.33, -0.4],
      [0.38, 0.39, -0.18],
      [0, 0.44, 0],
      [-0.42, 0.48, 0.22],
      [-0.9, 0.52, 0.45],
      [-1.5, 0.55, 0.72],
    ];
    const safeB: Array<[number, number, number]> = [
      [1.45, 0.2, -0.82],
      [1.12, 0.27, -0.62],
      [0.76, 0.36, -0.4],
      [0.42, 0.58, -0.18],
      [0.08, 0.85, 0],
      [-0.35, 0.77, 0.22],
      [-0.88, 0.62, 0.45],
      [-1.5, 0.57, 0.72],
    ];

    const drawDrone = (
      points: Array<[number, number, number]>,
      position: number,
      width: number,
      height: number,
      color: string,
    ) => {
      const scaled = Math.min(points.length - 1, Math.max(0, position * (points.length - 1)));
      const index = Math.min(points.length - 2, Math.floor(scaled));
      const amount = scaled - index;
      const a = points[index];
      const b = points[index + 1];
      const point = project(
        a[0] + (b[0] - a[0]) * amount,
        a[1] + (b[1] - a[1]) * amount,
        a[2] + (b[2] - a[2]) * amount,
        width,
        height,
      );
      context.save();
      context.translate(point.x, point.y);
      context.strokeStyle = color;
      context.fillStyle = "#07100f";
      context.shadowColor = color;
      context.shadowBlur = 14;
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(-8, 0);
      context.lineTo(0, -4);
      context.lineTo(8, 0);
      context.lineTo(0, 4);
      context.closePath();
      context.fill();
      context.stroke();
      context.fillStyle = color;
      context.fillRect(-1.5, -1.5, 3, 3);
      context.restore();
    };

    const draw = (now: number) => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const elapsed = reducedMotion ? 0 : (now - startedAt) / 1000;
      context.clearRect(0, 0, width, height);

      const gradient = context.createRadialGradient(
        width * 0.5,
        height * 0.5,
        40,
        width * 0.5,
        height * 0.55,
        width * 0.7,
      );
      gradient.addColorStop(0, "rgba(18, 50, 49, .3)");
      gradient.addColorStop(1, "rgba(3, 8, 9, 0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      context.save();
      context.strokeStyle = "rgba(109, 255, 239, .11)";
      context.lineWidth = 1;
      for (let grid = -7; grid <= 7; grid += 1) {
        const a = project(grid * 0.28, 0, -1.45, width, height);
        const b = project(grid * 0.28, 0, 1.5, width, height);
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
        const c = project(-1.9, 0, grid * 0.24, width, height);
        const d = project(1.9, 0, grid * 0.24, width, height);
        context.beginPath();
        context.moveTo(c.x, c.y);
        context.lineTo(d.x, d.y);
        context.stroke();
      }
      context.restore();

      const buildings = [
        [-1.25, -0.34, 0.18],
        [-0.75, 0.55, 0.3],
        [0.82, 0.56, 0.22],
        [1.18, -0.23, 0.38],
        [-0.2, -0.74, 0.24],
        [0.28, 0.83, 0.16],
      ];
      buildings.forEach(([x, z, h], index) => {
        const base = project(x, 0, z, width, height);
        const top = project(x, h, z, width, height);
        const buildingWidth = 14 + (index % 3) * 5;
        context.fillStyle = "rgba(7, 19, 20, .9)";
        context.strokeStyle = "rgba(107, 244, 231, .17)";
        context.lineWidth = 1;
        context.fillRect(base.x - buildingWidth / 2, top.y, buildingWidth, base.y - top.y);
        context.strokeRect(base.x - buildingWidth / 2, top.y, buildingWidth, base.y - top.y);
      });

      const conflict = project(0, 0.44, 0, width, height);
      if (phaseAtLeast(phase, "forecast") && !phaseAtLeast(phase, "committed")) {
        const pulse = 1 + Math.sin(elapsed * 5) * 0.08;
        context.save();
        context.translate(conflict.x, conflict.y);
        context.scale(pulse, pulse);
        context.fillStyle = "rgba(255, 95, 100, .08)";
        context.strokeStyle = "rgba(255, 95, 100, .8)";
        context.shadowColor = "#ff5f64";
        context.shadowBlur = 20;
        context.setLineDash([5, 4]);
        context.strokeRect(-31, -31, 62, 62);
        context.fillRect(-31, -31, 62, 62);
        context.restore();
      }

      const previewProgress = phase === "ready" ? 0.36 : 1;
      polyline(routeA, width, height, "#48eaff", 1.5, [7, 7], 8, previewProgress);
      polyline(unsafeB, width, height, "#48eaff", 1.5, [7, 7], 8, previewProgress);

      if (phaseAtLeast(phase, "rerouting")) {
        polyline(unsafeB, width, height, "rgba(255, 95, 100, .7)", 1.5, [3, 8], 5);
        if (memoryEnabled) {
          polyline(
            safeB,
            width,
            height,
            phaseAtLeast(phase, "committed") && authoritative ? "#caff58" : "#f4bd4f",
            phaseAtLeast(phase, "committed") && authoritative ? 3 : 2,
            phaseAtLeast(phase, "committed") && authoritative ? [] : [6, 5],
            18,
            Math.min(1, 0.25 + Math.max(0, elapsed) * 0.55),
          );
        }
      }

      if (phaseAtLeast(phase, "committed") && authoritative) {
        polyline(routeA, width, height, "#caff58", 3, [], 16);
        const travel = reducedMotion ? 0.66 : ((elapsed * 0.09) % 0.88) + 0.05;
        drawDrone(routeA, travel, width, height, "#caff58");
        drawDrone(safeB, travel, width, height, "#caff58");
      } else {
        drawDrone(routeA, 0.05, width, height, "#48eaff");
        drawDrone(unsafeB, 0.05, width, height, "#48eaff");
      }

      const nowLine = project(-1.78, 0, -1.1, width, height);
      context.fillStyle = "rgba(143, 175, 175, .65)";
      context.font = "10px ui-monospace, SFMono-Regular, monospace";
      context.fillText("NOW", nowLine.x - 4, nowLine.y + 24);
      context.fillText("T+14s", conflict.x + 40, conflict.y - 35);

      animationFrame = window.requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    animationFrame = window.requestAnimationFrame(draw);
    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [authoritative, memoryEnabled, phase, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      className="worldline-canvas"
      aria-label="Projected drone worldlines in a three-dimensional city airspace"
    />
  );
}

function StatusMark({ state }: { state: "waiting" | "active" | "done" | "error" }) {
  return <span className={`status-mark ${state}`} aria-hidden="true" />;
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("ready");
  const [result, setResult] = useState<RaceResult>(fallbackResult);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [clock, setClock] = useState("00:00:00Z");
  const [memoryPlane, setMemoryPlane] = useState<"connecting" | "live" | "degraded" | "demo">(
    API_BASE ? "connecting" : "demo",
  );
  const [regionCount, setRegionCount] = useState(3);
  const observedReceiptIds = useRef(new Set<string>());

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    if (!API_BASE) return;
    const controller = new AbortController();
    fetch(`${API_BASE}/health`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("health check failed");
        const health = await response.json();
        setMemoryPlane(health.mode === "live" ? "live" : "degraded");
        const regions = health.database?.regions;
        if (Array.isArray(regions) && regions.length > 0) {
          setRegionCount(regions.length);
        }
      })
      .catch((error) => {
        if (error.name !== "AbortError") setMemoryPlane("degraded");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!WEBSOCKET_URL) return;
    const socket = new WebSocket(`${WEBSOCKET_URL}?region=web`);
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.sourceTable === "commit_receipts") {
          observedReceiptIds.current.add(event.sourceKey);
          setResult((current) =>
            current.receiptId === event.sourceKey
              ? { ...current, cdcConfirmed: true }
              : current,
          );
        }
      } catch {
        // Resolved timestamps and malformed client messages are non-authoritative.
      }
    };
    return () => socket.close();
  }, []);

  useEffect(() => {
    const update = () =>
      setClock(
        new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          timeZone: "UTC",
        }).format(new Date()) + "Z",
      );
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const runDemo = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setPhase("forecast");
    await wait(reducedMotion ? 80 : 650);
    setPhase("recalling");

    let liveResult: RaceResult | null = null;
    if (API_BASE) {
      try {
        const response = await fetch(`${API_BASE}/v1/demo/race`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": `worldline-web-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ memoryEnabled }),
        });
        if (response.ok) liveResult = (await response.json()) as RaceResult;
        if (!response.ok) setMemoryPlane("degraded");
      } catch {
        liveResult = null;
        setMemoryPlane("degraded");
      }
    }

    await wait(reducedMotion ? 80 : 850);
    setPhase("race");
    await wait(reducedMotion ? 80 : 800);
    setPhase("rerouting");
    setResult(
      liveResult
        ? {
            ...liveResult,
            cdcConfirmed:
              liveResult.cdcConfirmed ||
              observedReceiptIds.current.has(liveResult.receiptId),
            mode: "live",
          }
        : {
            ...fallbackResult,
            maneuver: memoryEnabled
              ? fallbackResult.maneuver
              : "Deterministic emergency hold / +0 m",
          },
    );
    if (liveResult?.mode === "live") setMemoryPlane("live");
    await wait(reducedMotion ? 100 : 1100);
    if (liveResult?.rejected) {
      setPhase("rejected");
      setBusy(false);
      return;
    }
    setPhase("committed");
    await wait(reducedMotion ? 100 : 1200);
    setPhase("failure");
    if (API_BASE && liveResult?.mode === "live") {
      await fetch(`${API_BASE}/v1/demo/broker-failure`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": `worldline-broker-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ region: "eu-west-1" }),
      }).catch(() => {});
    }
    await wait(reducedMotion ? 100 : 850);
    setPhase("receipt");
    setBusy(false);
  }, [busy, memoryEnabled, reducedMotion]);

  const resetDemo = useCallback(() => {
    setPhase("ready");
    setBusy(false);
    setResult(fallbackResult);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === " " && !busy && phase === "ready") {
        event.preventDefault();
        void runDemo();
      }
      if (event.key.toLowerCase() === "r") resetDemo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, phase, resetDemo, runDemo]);

  const activeStep = useMemo(() => {
    if (phase === "ready") return -1;
    if (phase === "rejected") return 3;
    if (phaseAtLeast(phase, "committed")) return 4;
    return steps.findIndex((step) => step.id === phase);
  }, [phase]);

  const memoryState = phaseAtLeast(phase, "recalling") ? "done" : phase === "forecast" ? "active" : "waiting";
  const routeAState = phaseAtLeast(phase, "committed") ? "done" : phase === "race" ? "active" : "waiting";
  const routeBState = phaseAtLeast(phase, "rerouting")
    ? phase === "rejected"
      ? "error"
      : phaseAtLeast(phase, "committed")
      ? "done"
      : "active"
    : phase === "race"
      ? "error"
      : "waiting";
  const live = memoryPlane === "live" || result.mode === "live";
  const cdcReady =
    result.mode === "live"
      ? result.cdcConfirmed
      : phaseAtLeast(phase, "committed");

  return (
    <main className={`control-room phase-${phase}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-glyph" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div>
            <strong>WORLDLINE</strong>
            <span>Shared episodic memory for autonomous machines</span>
          </div>
        </div>
        <div className="system-line" aria-label="System status">
          <span className={`live-beacon ${live ? "live" : "demo"}`} />
          <strong>
            {live
              ? "MEMORY PLANE LIVE"
              : memoryPlane === "connecting"
                ? "CONNECTING MEMORY PLANE"
                : memoryPlane === "degraded"
                  ? "MEMORY PLANE DEGRADED"
                  : "DETERMINISTIC DEMO"}
          </strong>
          <span>/</span>
          <span>COCKROACHDB</span>
          <span>/</span>
          <span>AWS</span>
        </div>
        <div className="top-meta">
          <span>{clock}</span>
          <span className="region-stack"><i />{regionCount} REGIONS</span>
        </div>
      </header>

      <section className="mission-bar">
        <div>
          <span className="eyebrow">ACTIVE FORECAST</span>
          <strong>ATLAS CORRIDOR / X-17</strong>
        </div>
        <div className="mission-copy">
          <span className="agent-pill">2 AUTONOMOUS AGENTS</span>
          <h1>The future has happened before.</h1>
          <p>Remember it before machines move.</p>
        </div>
        <div className={`mission-status ${phase}`}>
          <span>
            {phase === "ready"
              ? "READY"
              : phase === "receipt"
                ? "PROVEN"
                : phase === "rejected"
                  ? "BLOCKED"
                  : phase.toUpperCase()}
          </span>
          <strong>
            {phase === "ready"
              ? "Awaiting commitment"
              : phase === "rejected"
                ? "Unsafe future rejected"
              : phaseAtLeast(phase, "committed")
                ? "Collision-free future"
                : phaseAtLeast(phase, "race")
                  ? "Invariants contested"
                  : "Searching episodic memory"}
          </strong>
        </div>
      </section>

      <section className="workspace">
        <aside className="memory-panel panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">01 / EPISODIC MEMORY</span>
              <h2>What the agent remembers</h2>
            </div>
            <span className={`count-chip ${memoryState}`}>01 MATCH</span>
          </div>

          <div className={`memory-card ${memoryState}`}>
            <div className="memory-card-head">
              <span>{result.memoryId}</span>
              <span>{result.memoryAge}</span>
            </div>
            <div className="memory-score">
              <strong>{phaseAtLeast(phase, "recalling") ? result.similarity : "—"}<small>%</small></strong>
              <span>SCENARIO<br />SIMILARITY</span>
            </div>
            <h3>Converging approach under crosswind</h3>
            <p>
              Two medium cargo vehicles entered the same exclusion halo with
              low vertical separation and asymmetric battery reserve.
            </p>
            <div className="memory-facts">
              <div><span>Closure</span><strong>18.4 m/s</strong></div>
              <div><span>Crosswind</span><strong>11.2 kn</strong></div>
              <div><span>Battery</span><strong>47 / 71%</strong></div>
              <div><span>Geometry</span><strong>87° merge</strong></div>
            </div>
            <div className="remembered-action">
              <span>SUCCESSFUL MANEUVER</span>
              <strong>Vertical separation / +38 m</strong>
              <small>Outcome verified · zero loss of separation</small>
            </div>
            <div className="memory-provenance">
              <span><i />Signed telemetry</span>
              <span>Singapore UTM</span>
              <span>Outcome: verified</span>
            </div>
          </div>

          <label className="memory-toggle">
            <input
              type="checkbox"
              checked={memoryEnabled}
              onChange={(event) => setMemoryEnabled(event.target.checked)}
              disabled={busy}
            />
            <span>
              <strong>Use episodic memory</strong>
              <small>Disable to expose the unsafe counterfactual</small>
            </span>
            <i aria-hidden="true" />
          </label>

          <div className={`causal-link ${memoryEnabled && phaseAtLeast(phase, "rerouting") ? "active" : ""}`}>
            <span className="eyebrow">CAUSAL TRACE</span>
            <div>
              <span>{result.memoryId}</span>
              <i>→</i>
              <span>MANEUVER-03</span>
              <i>→</i>
              <span>ROUTE B</span>
            </div>
            <p>The remembered outcome selected the maneuver that changed the committed path.</p>
          </div>
        </aside>

        <section className="world-panel panel">
          <div className="world-head">
            <div>
              <span className="eyebrow">02 / PREDICTED AIRSPACE</span>
              <h2>One physical world. Competing futures.</h2>
            </div>
            <div className="view-controls" aria-label="Worldline legend">
              <span><i className="cyan" />Proposed</span>
              <span><i className="red" />Unremembered</span>
              <span><i className="lime" />Committed</span>
            </div>
          </div>

          <div className="canvas-wrap">
            <WorldlineCanvas
              phase={phase}
              reducedMotion={reducedMotion}
              authoritative={cdcReady}
              memoryEnabled={memoryEnabled}
            />
            <div className="agent-tag agent-a">
              <span>A</span>
              <div><strong>KESTREL-7</strong><small>us-east-1</small></div>
            </div>
            <div className="agent-tag agent-b">
              <span>B</span>
              <div><strong>ORBITAL-3</strong><small>ap-south-1</small></div>
            </div>
            <div className={`conflict-label ${phaseAtLeast(phase, "forecast") ? "visible" : ""}`}>
              <span>FUTURE CONFLICT</span>
              <strong>CELL X-17 · T+14.2s</strong>
              <small>minimum separation 0.0 m / required 30 m</small>
            </div>
            <div className={`memory-pulse ${phase === "recalling" ? "visible" : ""}`}>
              <span>{memoryEnabled ? "MEMORY FOUND" : "MEMORY BYPASSED"}</span>
              <strong>{memoryEnabled ? "94% ANALOGUE" : "COUNTERFACTUAL MODE"}</strong>
            </div>
            <div className={`reroute-label ${phaseAtLeast(phase, "rerouting") ? "visible" : ""}`}>
              <span>{memoryEnabled ? "MEMORY CHANGED ACTION" : "UNSAFE FUTURE BLOCKED"}</span>
              <strong>{memoryEnabled ? "+38 m vertical separation" : "0.0 m / no movement token"}</strong>
            </div>
            <div className={`region-failure ${phaseAtLeast(phase, "failure") ? "visible" : ""}`}>
              <span className="failure-icon">×</span>
              <div><strong>EU BROKER DISCONNECTED</strong><small>Commitment plane remains available</small></div>
              <span className="survival-chip">REGION SURVIVAL</span>
            </div>
          </div>

          <div className="world-footer">
            <button
              className="run-button"
              type="button"
              onClick={() => (phase === "ready" ? void runDemo() : resetDemo())}
              disabled={busy && phase !== "ready"}
            >
              <span>
                <small>{phase === "ready" ? "SPACE TO RUN" : phase === "receipt" || phase === "rejected" ? "R TO RESET" : "COMMITTING"}</small>
                <strong>{phase === "ready" ? "Commit both futures" : phase === "receipt" || phase === "rejected" ? "Run the race again" : memoryEnabled ? "Memory is shaping the route" : "Safety validation is running"}</strong>
              </span>
              <i aria-hidden="true">{phase === "ready" ? "↗" : phase === "receipt" || phase === "rejected" ? "↻" : "•••"}</i>
            </button>
            <div className="invariant-strip">
              <div><span>MIN SEPARATION</span><strong>{phaseAtLeast(phase, "committed") ? "38.0 m" : "0.0 m"}</strong></div>
              <div><span>HORIZON</span><strong>45 seconds</strong></div>
              <div><span>POLICY</span><strong>UTM-4.7</strong></div>
              <div><span>WORLD STATE</span><strong>{phaseAtLeast(phase, "committed") ? "SERIALIZABLE" : "PROPOSED"}</strong></div>
            </div>
          </div>
        </section>

        <aside className="ledger-panel panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">03 / COMMIT LEDGER</span>
              <h2>What reality accepted</h2>
            </div>
            <span className="ledger-id">{result.runId}</span>
          </div>

          <div className="ledger-stack">
            <article>
              <StatusMark state={routeAState} />
              <div>
                <span>ROUTE A · KESTREL-7</span>
                <strong>Original worldline</strong>
                <small>Agent ingress / us-east-1</small>
              </div>
              <b>{routeAState === "done" ? "COMMIT" : routeAState === "active" ? "RACING" : "WAIT"}</b>
            </article>
            <article className={routeBState === "error" ? "has-error" : ""}>
              <StatusMark state={routeBState} />
              <div>
                <span>ROUTE B · ORBITAL-3</span>
                <strong>{phase === "rejected" ? "Unsafe counterfactual" : phaseAtLeast(phase, "rerouting") ? "Memory-shaped worldline" : "Original worldline"}</strong>
                <small>Agent ingress / ap-south-1</small>
              </div>
              <b>
                {routeBState === "done"
                  ? "COMMIT"
                  : routeBState === "error"
                    ? phase === "rejected"
                      ? "REJECT"
                      : "40001"
                    : routeBState === "active"
                      ? "RETRY"
                      : "WAIT"}
              </b>
            </article>
          </div>

          <div className="transaction-card">
            <div className="transaction-head">
              <span>SERIALIZABLE ADMISSION</span>
              <strong>
                {phase === "rejected"
                  ? "COMMIT REJECTED"
                  : phaseAtLeast(phase, "committed")
                    ? "ATOMIC COMMIT"
                    : "PENDING"}
              </strong>
            </div>
            {[
              ["Policy version", "UTM-4.7", phaseAtLeast(phase, "race")],
              ["Corridor capacity", "1 / 1", phaseAtLeast(phase, "race")],
              ["Exclusion claims", phase === "rejected" ? "0 committed" : "24 cells", phaseAtLeast(phase, "rerouting")],
              ["Memory dependency", phase === "rejected" ? "bypassed" : result.memoryId, phaseAtLeast(phase, "rerouting")],
              ["Command outbox", "2 signed", phaseAtLeast(phase, "committed")],
            ].map(([label, value, done]) => (
              <div className={`transaction-row ${done ? "done" : ""}`} key={String(label)}>
                <span>{label}</span>
                <strong>{done ? value : "—"}</strong>
                <i>{done ? "✓" : "·"}</i>
              </div>
            ))}
          </div>

          <div className={`cdc-card ${cdcReady ? "active" : ""}`}>
            <div>
              <span className="eyebrow">CHANGEFEED WITNESS</span>
              <strong>{cdcReady ? "COMMIT OBSERVED" : "AWAITING MVCC EVENT"}</strong>
            </div>
            <span className="cdc-wave"><i /><i /><i /><i /><i /></span>
            <small>at-least-once · per-key ordered · deduplicated</small>
          </div>

          <div className={`receipt-card ${phase === "receipt" || phase === "rejected" ? "visible" : ""}`}>
            <div className="receipt-head">
              <span>COMMIT RECEIPT</span>
              <strong>{result.receiptId}</strong>
            </div>
            <dl>
              <div><dt>Memory</dt><dd>{result.memoryId} / {result.similarity}%</dd></div>
              <div><dt>Maneuver</dt><dd>{result.maneuver}</dd></div>
              <div><dt>Retry count</dt><dd>{result.retryCount}</dd></div>
              <div><dt>CDC</dt><dd>{result.cdcConfirmed ? "confirmed" : "pending"}</dd></div>
              <div><dt>HLC</dt><dd>{result.decisionHlc.slice(0, 19)}…</dd></div>
            </dl>
            <div className="receipt-seal">
              <i>{phase === "rejected" ? "×" : "✓"}</i>
              <span>
                {phase === "rejected" ? "MOVEMENT BLOCKED" : "WORLD STATE PROVEN"}
                <br />
                <small>{phase === "rejected" ? "SAFETY INVARIANT" : "MVCC + SHA-256"}</small>
              </span>
            </div>
          </div>
        </aside>
      </section>

      <footer className="timeline">
        <div className="timeline-title">
          <span className="eyebrow">DECISION PATH</span>
          <strong>Memory → maneuver → reality</strong>
        </div>
        <div className="timeline-steps">
          {steps.map((step, index) => (
            <div
              key={step.id}
              className={`timeline-step ${index < activeStep ? "done" : index === activeStep ? "active" : ""}`}
            >
              <i>{index < activeStep ? "✓" : `0${index + 1}`}</i>
              <div><strong>{step.label}</strong><small>{
                ["Detect future overlap", "Retrieve prior outcome", "Serialize commitments", "Apply remembered maneuver", "Issue movement tokens"][index]
              }</small></div>
            </div>
          ))}
        </div>
        <div className="footer-tech">
          <span>VECTOR / MVCC / CDC</span>
          <strong>COCKROACHDB</strong>
        </div>
      </footer>
    </main>
  );
}
