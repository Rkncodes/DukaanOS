import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Schemas } from "../../../lib/api/client";
import { formatINR, formatQuantity } from "../../../lib/format";
import { addReferencePhoto, recognizeFrame } from "./api";
import { CameraError, captureFrame, captureRegion, openCamera, stopStream } from "./camera";
import { DetectionOverlay, MockNotice, describeDetection } from "./DetectionOverlay";
import type { Detection, Product } from "./review";
import {
  billProduct,
  markCommitted,
  quantityInBill,
  remainingToAdd,
  updateTracks,
  type Track,
} from "./tracking";

export const SCAN_INTERVAL_MS = 1500;

type Phase = "starting" | "live" | "error";

type Props = {
  /** The existing Counter cart (display only: what is already in the bill). */
  cart: Schemas["CartRead"] | null;
  /** Adds items to the existing Counter cart (recognized-items -> add_item). */
  onConfirm: (items: Schemas["ConfirmedItem"][]) => Promise<unknown>;
  onClose: () => void;
  scanIntervalMs?: number;
};

/**
 * Live Vision Counter. The camera is scanned continuously; each product on the counter is a
 * *track* across frames (see tracking.ts), shown as a box with name and price. The merchant
 * commits a product deliberately; repeated frames never add it again.
 */
export function LiveVision({ cart, onConfirm, onClose, scanIntervalMs = SCAN_INTERVAL_MS }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextSequence = useRef(0);
  const latestShown = useRef(-1);

  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("starting");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [provider, setProvider] = useState<{ name: string; isMock: boolean } | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [taught, setTaught] = useState<Record<string, "saving" | "saved">>({});

  // Open the camera (again on "Try again"); always release it on exit.
  useEffect(() => {
    let cancelled = false;
    setPhase("starting");
    setCameraError(null);
    openCamera().then(
      (stream) => {
        if (cancelled) return stopStream(stream);
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          resume(video);
        }
        setPhase("live");
      },
      (e: unknown) => {
        if (cancelled) return;
        setCameraError(e instanceof CameraError ? e.message : "Could not start the camera.");
        setPhase("error");
      },
    );
    return () => {
      cancelled = true;
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [attempt]);

  const scanOnce = useCallback(async () => {
    const video = videoRef.current;
    const frame = video ? await captureFrame(video) : null;
    if (!frame) return null;
    return recognizeFrame(frame, nextSequence.current++);
  }, []);

  // Continuous recognition: one frame at a time, newest result wins, stops when not live.
  useEffect(() => {
    if (phase !== "live") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await scanOnce();
        if (!stopped && next && (next.sequence ?? 0) > latestShown.current) {
          latestShown.current = next.sequence ?? 0;
          setProvider({ name: next.provider, isMock: next.is_mock });
          setTracks((current) => updateTracks(current, next.detections));
          setScanError(null);
        }
      } catch (e) {
        if (!stopped) setScanError(e instanceof Error ? e.message : "Recognition failed");
      }
      if (!stopped) timer = setTimeout(tick, scanIntervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phase, scanIntervalMs, scanOnce]);

  /** The only way live detections reach the bill: an explicit merchant action. */
  async function commit(targets: Track[]) {
    const plan = targets
      .map((t) => ({ track: t, product: billProduct(t), quantity: remainingToAdd(t, cart) }))
      .filter((p): p is { track: Track; product: Product; quantity: number } => !!p.product && p.quantity > 0);
    if (plan.length === 0 || committing) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await onConfirm(plan.map((p) => ({ product_id: p.product.id, quantity: String(p.quantity) })));
      const commits = new Map(plan.map((p) => [p.track.key, p.quantity]));
      setTracks((current) => markCommitted(current, commits, cart));
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : "Could not add to the bill");
    } finally {
      setCommitting(false);
    }
  }

  const choose = (key: string, product: Product | null) =>
    setTracks((current) => current.map((t) => (t.key === key ? { ...t, chosen: product } : t)));

  /** Vision was not sure and the merchant said what it is: keep this packet's look as a reference photo. */
  async function teach(track: Track) {
    const video = videoRef.current;
    const { chosen, key } = track;
    if (!video || !chosen || !track.detection.bbox || taught[key]) return;
    setTaught((t) => ({ ...t, [key]: "saving" }));
    setCommitError(null);
    try {
      const photo = await captureRegion(video, track.detection.bbox);
      if (!photo) throw new Error("The camera has no picture yet. Try again.");
      await addReferencePhoto(chosen.id, photo);
      setTaught((t) => ({ ...t, [key]: "saved" }));
    } catch (e) {
      setTaught((t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== key)));
      setCommitError(e instanceof Error ? e.message : "Could not save the reference photo");
    }
  }

  function stop() {
    stopStream(streamRef.current);
    streamRef.current = null;
    onClose();
  }

  const ready = tracks.filter((t) => remainingToAdd(t, cart) > 0);
  // Unique ids per track (frame-local ids like "d0" repeat across tracks).
  const boxes = tracks.map((t) => ({ ...t.detection, id: t.key }));

  return (
    <section aria-label="Vision counter" className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-medium text-slate-900">
          Vision counter{" "}
          {phase === "live" && <span className="ml-1 text-xs font-normal text-emerald-700">● Live</span>}
        </h2>
        <button
          type="button"
          onClick={stop}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          Stop camera
        </button>
      </div>

      {phase === "error" ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p>{cameraError}</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-3 rounded-md bg-red-700 px-3 py-1.5 font-medium text-white hover:bg-red-800"
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="relative w-full overflow-hidden rounded-md bg-slate-900">
          <video ref={videoRef} aria-label="Live camera" muted playsInline className="block min-h-48 w-full" />
          <DetectionOverlay
            detections={boxes}
            detailed
            annotate={(_, i) => {
              const t = tracks[i];
              const product = billProduct(t);
              const inBill = product ? quantityInBill(cart, product.id) : 0;
              return {
                faded: t.status === "leaving",
                tag: t.status === "leaving" ? "leaving" : inBill > 0 ? `✓ in bill ×${inBill}` : undefined,
              };
            }}
          />
          {phase === "starting" && (
            <p role="status" className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white">
              Starting camera… Allow camera access if your browser asks.
            </p>
          )}
        </div>
      )}

      {provider?.isMock && (
        <div className="mt-3">
          <MockNotice>
            <strong>Test provider — not real recognition.</strong> Provider <code>{provider.name}</code> reports itself
            as a mock; its detections do not come from the camera image.
          </MockNotice>
        </div>
      )}
      {provider && !provider.isMock && (
        <p className="mt-3 text-xs text-slate-500" role="note" aria-label="Vision provider">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">Live model</span>{" "}
          <code>{provider.name}</code> · recognizing from the camera image
        </p>
      )}
      {scanError && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {scanError}
        </p>
      )}

      {phase !== "error" && (
        <>
          <div className="mb-1 mt-4 flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-slate-500">On the counter now</h3>
            <span className="text-xs text-slate-400">Nothing is billed until you add it.</span>
          </div>
          {tracks.length === 0 ? (
            <p className="text-sm text-slate-400">{phase === "live" ? "Looking for products…" : "—"}</p>
          ) : (
            <ul aria-label="On the counter" className="divide-y divide-slate-100">
              {tracks.map((t) => (
                <TrackRow
                  key={t.key}
                  track={t}
                  cart={cart}
                  busy={committing}
                  onAdd={() => void commit([t])}
                  onChoose={(p) => choose(t.key, p)}
                  taught={taught[t.key]}
                  onTeach={() => void teach(t)}
                />
              ))}
            </ul>
          )}
          {commitError && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {commitError}
            </p>
          )}
          <button
            type="button"
            disabled={ready.length === 0 || committing}
            onClick={() => void commit(ready)}
            className="mt-3 w-full rounded-md border border-emerald-600 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
          >
            {committing ? "Adding…" : `Add all ready (${ready.length})`}
          </button>
        </>
      )}
    </section>
  );
}

function TrackRow({
  track,
  cart,
  busy,
  onAdd,
  onChoose,
  taught,
  onTeach,
}: {
  track: Track;
  cart: Schemas["CartRead"] | null;
  busy: boolean;
  onAdd: () => void;
  onChoose: (product: Product | null) => void;
  taught: "saving" | "saved" | undefined;
  onTeach: () => void;
}) {
  const d = track.detection;
  const product = billProduct(track);
  const { title, note } = describeDetection(d);
  const name = product?.name ?? title;
  const remaining = remainingToAdd(track, cart);
  const inBill = product ? quantityInBill(cart, product.id) : 0;
  const confidence = d.confidence === null ? null : `${Math.round(d.confidence * 100)}%`;
  const leaving = track.status === "leaving";

  let action: ReactNode;
  if (leaving) {
    action = <span className="text-xs text-slate-400">Leaving view</span>;
  } else if (d.match === "unmatched") {
    action = <span className="text-xs text-slate-500">Not in catalog · won't be added</span>;
  } else if (!product) {
    action = (
      <div className="flex flex-wrap justify-end gap-1">
        <span className="w-full text-right text-xs text-amber-700">
          {d.match === "low_confidence" ? "Unsure. Confirm to add:" : "Which product is it?"}
        </span>
        {d.candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onChoose(c)}
            aria-label={d.match === "low_confidence" ? `Yes, it's ${c.name}` : `Choose ${c.name}`}
            className="rounded-full border border-slate-300 px-2 py-0.5 text-xs hover:border-emerald-500 hover:bg-emerald-50"
          >
            {d.match === "low_confidence" ? `Yes, it's ${c.name}` : `${c.name} · ${formatINR(c.price)}`}
          </button>
        ))}
      </div>
    );
  } else if (remaining > 0) {
    const more = track.committed > 0 && inBill > 0;
    action = (
      <button
        type="button"
        disabled={busy}
        onClick={onAdd}
        aria-label={`Add ${formatQuantity(String(remaining))} ${product.name} to bill`}
        className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {more ? `Add ${remaining} more` : `Add ×${remaining}`}
      </button>
    );
  } else {
    action = <span className="text-sm font-medium text-emerald-700">✓ Added</span>;
  }

  return (
    <li
      aria-label={`${name}${leaving ? " (leaving)" : ""}`}
      data-status={track.status}
      className={`flex items-start justify-between gap-3 py-2 ${leaving ? "opacity-50" : ""}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {track.status === "new" && (
            <span className="rounded bg-emerald-100 px-1 text-[10px] font-semibold uppercase text-emerald-800">New</span>
          )}
          <span className={`truncate font-medium ${d.match === "unmatched" ? "text-slate-500" : "text-slate-900"}`}>
            {d.match === "unmatched" ? `Unknown: ${title}` : name}
          </span>
        </div>
        <div className="text-xs text-slate-500">
          ×{formatQuantity(d.quantity)}
          {product && ` · ${formatINR(product.price)}`}
          {confidence && ` · ${confidence}`}
          {note && !product && ` · ${note}`}
          {basis(d) && ` · ${basis(d)}`}
          {inBill > 0 && <span className="text-emerald-700"> · in bill ×{inBill}</span>}
          {track.chosen && d.match !== "matched" && (
            <>
              <button type="button" onClick={() => onChoose(null)} className="ml-1 underline hover:text-slate-800">
                change
              </button>
              {!leaving && d.bbox && (
                <button
                  type="button"
                  disabled={taught !== undefined}
                  onClick={onTeach}
                  aria-label={`Remember this packet as ${track.chosen.name}`}
                  title="Save how this packet looks, so Vision recognizes it next time"
                  className="ml-2 underline hover:text-slate-800 disabled:no-underline"
                >
                  {taught === "saved" ? "✓ remembered" : taught === "saving" ? "saving…" : "remember this packet"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="shrink-0 text-right">{action}</div>
    </li>
  );
}

/** What the recognition rests on (real vision reports its evidence; scores are not probabilities). */
function basis(d: Detection): string | null {
  const e = d.evidence;
  if (!e || d.match === "unmatched") return null;
  const parts = [e.text > 0 && "name read on pack", e.reference > 0 && "matches your photo"].filter(Boolean);
  return parts.length > 0 ? parts.join(" + ") : "by look only";
}

function resume(video: HTMLVideoElement) {
  try {
    void video.play()?.catch(() => {});
  } catch {
    // Autoplay can be refused; the stream still attaches and frames still capture.
  }
}
