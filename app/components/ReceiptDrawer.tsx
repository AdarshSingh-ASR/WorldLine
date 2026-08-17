"use client";

import { useEffect, useRef } from "react";
import {
  regionLabel,
  shortHlc,
  type RaceResult,
  type Receipt,
} from "../lib/worldline";

type Props = {
  open: boolean;
  receipt: Receipt | null;
  error: string | null;
  result: RaceResult | null;
  onClose: () => void;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="receipt-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The show-your-work surface. Everything here is read back from the receipt
 * row and the historical world snapshot the agent reconstructed with
 * AS OF SYSTEM TIME — nothing is recomputed in the browser.
 */
export default function ReceiptDrawer({
  open,
  receipt,
  error,
  result,
  onClose,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const evidence = (receipt?.evidence ?? {}) as Record<string, unknown>;

  return (
    <div className="drawer-scrim" role="presentation" onClick={onClose}>
      <section
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Commit receipt"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <span className="eyebrow">COMMIT RECEIPT</span>
            <h2 className="mono">{receipt?.id ?? result?.receiptId ?? "—"}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="ghost mono"
            onClick={onClose}
          >
            CLOSE ESC
          </button>
        </header>

        {error ? (
          <p className="inline-error mono" role="alert">
            {error}
          </p>
        ) : !receipt ? (
          <p className="mono dim">reading receipt from CockroachDB…</p>
        ) : (
          <div className="drawer-body">
            <dl className="receipt-grid mono">
              <Row label="MVCC timestamp" value={String(receipt.asOf)} />
              <Row
                label="Decision HLC"
                value={String(receipt.decision_hlc)}
              />
              <Row
                label="Content hash"
                value={
                  <span className="hash">{String(receipt.content_hash)}</span>
                }
              />
              <Row
                label="CDC observed"
                value={
                  <b data-ok={receipt.cdc_observed ? "true" : "false"}>
                    {receipt.cdc_observed ? "CONFIRMED" : "PENDING"}
                  </b>
                }
              />
              <Row
                label="S3 archive"
                value={
                  receipt.archived
                    ? String(receipt.archive_key)
                    : "not archived (no receipt bucket configured)"
                }
              />
              {typeof receipt.agent_id === "string" ? (
                <Row label="Agent" value={receipt.agent_id} />
              ) : null}
              {typeof receipt.corridor_id === "string" ? (
                <Row label="Committed corridor" value={receipt.corridor_id} />
              ) : null}
              {typeof receipt.memory_id === "string" ? (
                <Row label="Memory dependency" value={receipt.memory_id} />
              ) : null}
            </dl>

            {result?.routes?.length ? (
              <>
                <h3 className="eyebrow">COMMITTED EXCLUSION CLAIMS</h3>
                <ul className="claims mono">
                  {result.routes.map((route) => (
                    <li key={route.decisionId}>
                      <span>
                        {route.agentId} · {regionLabel(route.homeRegion)}
                      </span>
                      <span className="dim">
                        {route.corridorId} · {route.cells?.join(" ")} ·{" "}
                        {route.safety?.achievedSeparationM}m ·{" "}
                        {route.retryCount > 0
                          ? `${route.retryCount}× 40001`
                          : "first attempt"}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {Array.isArray(receipt.worldSnapshot) &&
            receipt.worldSnapshot.length > 0 ? (
              <>
                <h3 className="eyebrow">
                  WORLD STATE AT ADMISSION · AS OF SYSTEM TIME
                </h3>
                <ul className="claims mono">
                  {receipt.worldSnapshot.map((row, index) => {
                    const record = row as Record<string, unknown>;
                    return (
                      <li key={String(record.id ?? index)}>
                        <span>
                          {String(record.agent_id ?? "—")} ·{" "}
                          {String(record.state ?? "—")}
                        </span>
                        <span className="dim">
                          {String(record.corridor_id ?? "—")} · memory=
                          {String(record.selected_memory_id ?? "none")} · hlc=
                          {shortHlc(String(record.decision_hlc ?? ""))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}

            {Object.keys(evidence).length > 0 ? (
              <>
                <h3 className="eyebrow">SIGNED EVIDENCE</h3>
                <pre className="evidence mono">
                  {JSON.stringify(evidence, null, 2)}
                </pre>
              </>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
