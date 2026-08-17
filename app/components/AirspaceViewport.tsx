"use client";

import { useEffect, useRef } from "react";
import type { Briefing, CommittedRoute, RaceResult } from "../lib/worldline";
import { regionKey, regionSlot } from "../lib/worldline";

/**
 * Airspace and space-time viewport.
 *
 * Geometry is derived, never authored. Corridor identity, claimed cell count,
 * the achieved separation in metres and which route took the alternate
 * corridor all come from the committed decision the agent returned. The bend
 * magnitude is the real `achievedSeparationM` scaled into view space, so a
 * different maneuver produces a visibly different trajectory.
 *
 * The deliberate visual risk: the space-time grid compresses toward the
 * contested slot. Grid spacing is a function of distance from the conflict,
 * so the lattice visibly densifies where scheduling pressure is highest.
 */

export type ViewportPhase =
  | "unavailable"
  | "loading"
  | "briefed"
  | "committing"
  | "resolved";

type Props = {
  phase: ViewportPhase;
  briefing: Briefing | null;
  result: RaceResult | null;
  reducedMotion: boolean;
  cdcConfirmed: boolean;
  offlineRegions: string[];
};

/** Palette must mirror the region slots used by CSS so labels agree. */
const REGION_COLORS = [
  "#5b8ac9", // slot 0 — us-east-1
  "#9182c4", // slot 1 — eu-west-1
  "#3f9e93", // slot 2 — ap-south-1
  "#7d8fa3",
  "#6b7f95",
  "#8a94a8",
];

const COMMITTED = "#3fbf7f";
const CONFLICT = "#e0603a";
const PROPOSED = "#7fa8bd";
const GRID = "rgba(126, 166, 190, 0.16)";
const GRID_HOT = "rgba(224, 96, 58, 0.30)";

function regionColor(region: string | null | undefined) {
  return REGION_COLORS[regionSlot(region) % REGION_COLORS.length];
}

type Point = { x: number; y: number; z: number };

/**
 * Corridor centrelines in scenario space. x runs along the corridor, z is
 * lateral, y is altitude in metres. Two agents converge on x = 0.
 */
function baseTrack(index: number): Point[] {
  const direction = index === 0 ? 1 : -1;
  const lateral = index === 0 ? -1 : 1;
  const points: Point[] = [];
  for (let step = 0; step <= 16; step += 1) {
    const t = step / 16;
    const x = direction * (t * 2 - 1);
    // Converging merge: lateral offset collapses to zero at the conflict.
    const z = lateral * (1 - t) * 0.72 * direction;
    points.push({ x, y: 0, z: z * direction });
  }
  return points;
}

/**
 * Applies the real committed maneuver to a track. `achievedSeparationM` is the
 * deterministic safety output, so the visible vertical displacement is the
 * separation the database actually accepted.
 */
function applyManeuver(
  track: Point[],
  route: CommittedRoute | null,
  metresPerUnit: number,
): Point[] {
  if (!route) return track;
  const altitude = route.useAlternate
    ? (route.safety?.achievedSeparationM ?? 0)
    : 0;
  if (altitude === 0) return track;
  return track.map((point, index) => {
    const t = index / (track.length - 1);
    // Raise into the alternate corridor around the contested slot and settle.
    const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.7;
    return { ...point, y: point.y + (altitude / metresPerUnit) * envelope };
  });
}

export default function AirspaceViewport({
  phase,
  briefing,
  result,
  reducedMotion,
  cdcConfirmed,
  offlineRegions,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    phase,
    briefing,
    result,
    reducedMotion,
    cdcConfirmed,
    offlineRegions,
  });
  // The frame loop reads the latest props through this ref. It is written in
  // an effect (never during render) and this effect is declared before the
  // repaint effect below, so the mirror is always current before a paint.
  useEffect(() => {
    stateRef.current = {
      phase,
      briefing,
      result,
      reducedMotion,
      cdcConfirmed,
      offlineRegions,
    };
  }, [phase, briefing, result, reducedMotion, cdcConfirmed, offlineRegions]);

  // Marks the moment the resolved state arrived so the bend animates from a
  // real event rather than a scripted delay.
  const resolvedAtRef = useRef<number | null>(null);
  useEffect(() => {
    resolvedAtRef.current = phase === "resolved" ? performance.now() : null;
  }, [phase, result?.runId]);

  // Lets state changes force a paint. With animation frames available this is
  // redundant; where they are throttled it is what keeps the view truthful.
  const renderRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    renderRef.current?.();
  }, [phase, result, cdcConfirmed, reducedMotion, offlineRegions, briefing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let width = 0;
    let height = 0;

    /**
     * The draw loop owns buffer sizing. A ResizeObserver alone is not enough
     * here: the panel's grid row resolves after the first frames, so an
     * observer-only sync can latch a pre-layout rect and leave the backing
     * store stretched. Re-checking every frame is cheap and always correct.
     */
    const syncSize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      const targetWidth = Math.max(1, Math.floor(rect.width * ratio));
      const targetHeight = Math.max(1, Math.floor(rect.height * ratio));
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      // setTransform must be reapplied after any buffer resize.
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const project = (point: Point) => {
      const scale = Math.min(width, height) * 0.31;
      const altitudeUnits = point.y;
      return {
        x: width * 0.5 + point.x * scale * 1.12 + point.z * scale * 0.42,
        y:
          height * 0.68 -
          altitudeUnits * scale -
          point.z * scale * 0.24,
      };
    };

    /**
     * Non-linear grid spacing. Lines cluster toward x = 0 (the contested
     * slot), so the lattice itself shows where the future is congested.
     */
    const compress = (t: number) => Math.sign(t) * Math.abs(t) ** 1.85;

    const drawGrid = (hot: number) => {
      context.save();
      context.lineWidth = 1;
      for (let i = -10; i <= 10; i += 1) {
        const raw = i / 10;
        const x = compress(raw) * 2;
        const proximity = 1 - Math.min(1, Math.abs(raw));
        context.strokeStyle =
          hot > 0 && proximity > 0.55
            ? GRID_HOT
            : GRID;
        const a = project({ x, y: 0, z: -1.15 });
        const b = project({ x, y: 0, z: 1.15 });
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
      for (let i = -6; i <= 6; i += 1) {
        const z = (i / 6) * 1.15;
        context.strokeStyle = GRID;
        context.beginPath();
        for (let step = 0; step <= 40; step += 1) {
          const raw = (step / 40) * 2 - 1;
          const point = project({ x: compress(raw) * 2, y: 0, z });
          if (step === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        }
        context.stroke();
      }
      context.restore();
    };

    const drawTrack = (
      track: Point[],
      color: string,
      lineWidth: number,
      dash: number[],
      progress: number,
    ) => {
      const count = Math.max(2, Math.ceil(track.length * progress));
      context.save();
      context.setLineDash(dash);
      context.lineWidth = lineWidth;
      context.strokeStyle = color;
      context.lineJoin = "round";
      context.beginPath();
      track.slice(0, count).forEach((point, index) => {
        const projected = project(point);
        if (index === 0) context.moveTo(projected.x, projected.y);
        else context.lineTo(projected.x, projected.y);
      });
      context.stroke();
      context.restore();
    };

    const drawVehicle = (
      track: Point[],
      t: number,
      color: string,
    ) => {
      const scaled = Math.min(
        track.length - 1,
        Math.max(0, t * (track.length - 1)),
      );
      const index = Math.min(track.length - 2, Math.floor(scaled));
      const amount = scaled - index;
      const a = track[index];
      const b = track[index + 1];
      const point = project({
        x: a.x + (b.x - a.x) * amount,
        y: a.y + (b.y - a.y) * amount,
        z: a.z + (b.z - a.z) * amount,
      });
      context.save();
      context.translate(point.x, point.y);
      context.fillStyle = color;
      context.strokeStyle = "rgba(7, 11, 18, 0.9)";
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(-6, 0);
      context.lineTo(0, -4.5);
      context.lineTo(6, 0);
      context.lineTo(0, 4.5);
      context.closePath();
      context.fill();
      context.stroke();
      context.restore();
    };

    const label = (
      text: string,
      x: number,
      y: number,
      color: string,
      size = 10,
    ) => {
      context.save();
      context.font = `${size}px ui-monospace, "Cascadia Mono", Consolas, monospace`;
      context.fillStyle = color;
      context.fillText(text, x, y);
      context.restore();
    };

    const draw = (now: number) => {
      const {
        phase: currentPhase,
        briefing: currentBriefing,
        result: currentResult,
        reducedMotion: reduced,
        cdcConfirmed: confirmed,
        offlineRegions: offline,
      } = stateRef.current;

      syncSize();
      context.clearRect(0, 0, width, height);

      if (currentPhase === "unavailable" || currentPhase === "loading") {
        drawGrid(0);
        label(
          currentPhase === "loading"
            ? "ACQUIRING WORLD STATE…"
            : "NO AUTHORITATIVE WORLD STATE",
          width * 0.5 - 96,
          height * 0.5,
          "rgba(160, 186, 200, 0.75)",
          11,
        );
        frame = requestAnimationFrame(draw);
        return;
      }

      const routes = currentResult?.routes ?? [];
      // Scale so the largest real separation reads clearly in view space.
      const maxSeparation = Math.max(
        38,
        ...routes.map((route) => route.safety?.achievedSeparationM ?? 0),
      );
      const metresPerUnit = maxSeparation / 0.42;

      const agents = currentBriefing?.agents ?? [];
      const tracks = [0, 1].map((index) => {
        const route =
          routes.find(
            (candidate) => candidate.agentId === agents[index]?.id,
          ) ?? routes[index] ?? null;
        return {
          route,
          agent: agents[index] ?? null,
          base: baseTrack(index),
        };
      });

      const resolvedAt = resolvedAtRef.current;
      const sinceResolved =
        resolvedAt === null ? 0 : Math.max(0, (now - resolvedAt) / 1000);
      const bendProgress = reduced
        ? currentPhase === "resolved"
          ? 1
          : 0
        : Math.min(1, sinceResolved / 0.9);
      const flash =
        currentPhase === "resolved" && !reduced
          ? Math.max(0, 1 - sinceResolved / 0.55)
          : 0;

      const contested = currentPhase !== "resolved" || bendProgress < 1;
      drawGrid(contested ? 1 : 0);

      // Contested slot marker, sized from the real required separation.
      const conflict = project({ x: 0, y: 0, z: 0 });
      if (currentPhase !== "resolved" || bendProgress < 1) {
        const pulse = reduced ? 1 : 1 + Math.sin(now / 190) * 0.05;
        context.save();
        context.translate(conflict.x, conflict.y);
        context.scale(pulse, pulse);
        context.strokeStyle = CONFLICT;
        context.fillStyle = "rgba(224, 96, 58, 0.10)";
        context.lineWidth = 1.25;
        context.setLineDash([4, 4]);
        context.beginPath();
        context.rect(-26, -26, 52, 52);
        context.fill();
        context.stroke();
        context.restore();
      }

      if (flash > 0) {
        context.save();
        context.globalAlpha = flash;
        context.strokeStyle = "#ffd9c9";
        context.lineWidth = 2;
        const spread = 26 + (1 - flash) * 46;
        context.strokeRect(
          conflict.x - spread,
          conflict.y - spread,
          spread * 2,
          spread * 2,
        );
        context.restore();
      }

      for (const { route, agent, base } of tracks) {
        const color = regionColor(agent?.homeRegion ?? route?.homeRegion);
        const isOffline = offline.includes(
          regionKey(agent?.homeRegion ?? route?.homeRegion),
        );
        const bent = applyManeuver(base, route, metresPerUnit);
        const shown = bent.map((point, index) => ({
          ...point,
          y: base[index].y + (point.y - base[index].y) * bendProgress,
        }));

        if (currentPhase === "briefed" || currentPhase === "committing") {
          drawTrack(base, PROPOSED, 1.4, [6, 5], 1);
        }

        if (currentPhase === "resolved" && route) {
          // The unremembered counterfactual stays visible for the route that
          // actually had to move.
          if (route.useAlternate) {
            drawTrack(base, "rgba(224, 96, 58, 0.55)", 1.2, [3, 6], 1);
          }
          drawTrack(
            shown,
            confirmed ? COMMITTED : color,
            confirmed ? 2.6 : 2,
            confirmed ? [] : [7, 4],
            1,
          );
          const travel = reduced
            ? 0.6
            : ((now / 1000) * 0.16 + (route.useAlternate ? 0.5 : 0)) % 1;
          drawVehicle(
            shown,
            travel,
            isOffline ? "rgba(150,160,172,0.7)" : confirmed ? COMMITTED : color,
          );
        } else {
          drawVehicle(base, 0.06, color);
        }
      }

      // Axis annotations, all from real values.
      label(
        "NOW",
        project({ x: -2, y: 0, z: -1.15 }).x,
        project({ x: -2, y: 0, z: -1.15 }).y + 18,
        "rgba(150, 176, 190, 0.7)",
      );
      label(
        `CONTESTED SLOT · ${currentResult?.routes?.[0]?.corridorId ?? currentBriefing?.corridors?.[0]?.corridor_id ?? "—"}`,
        conflict.x + 34,
        conflict.y - 34,
        CONFLICT,
      );
      if (currentPhase === "resolved" && bendProgress > 0.4) {
        const alt = routes.find((route) => route.useAlternate);
        if (alt) {
          label(
            `+${alt.safety?.achievedSeparationM ?? 0} m · ${alt.corridorId}`,
            conflict.x + 34,
            conflict.y - 18,
            COMMITTED,
          );
        }
      }

      frame = requestAnimationFrame(draw);
    };

    /**
     * Paint synchronously, then let the frame loop take over. Drawing once up
     * front means the viewport is never blank in contexts where animation
     * frames are throttled or suspended (background tabs, non-composited
     * embeds), and it also makes the first paint independent of frame timing.
     */
    const render = () => {
      cancelAnimationFrame(frame);
      draw(performance.now());
    };

    renderRef.current = render;
    syncSize();
    render();

    // Layout in this panel resolves after mount, so a resize signal must be
    // able to correct the backing store without waiting for a frame. Both
    // signals are registered because they fail in different situations: the
    // observer catches panel-only reflows, the window event survives contexts
    // where observer callbacks are not delivered.
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    window.addEventListener("resize", render);

    return () => {
      renderRef.current = null;
      observer.disconnect();
      window.removeEventListener("resize", render);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="viewport-canvas"
      role="img"
      aria-label={
        phase === "resolved" && result
          ? `Airspace view. ${result.routes.length} committed routes. ${
              result.routes.find((route) => route.useAlternate)
                ? `One route displaced to corridor ${result.routes.find((route) => route.useAlternate)?.corridorId} with ${result.routes.find((route) => route.useAlternate)?.safety?.achievedSeparationM} metres separation.`
                : ""
            }`
          : "Airspace view showing two proposed routes converging on a contested future slot."
      }
    />
  );
}
