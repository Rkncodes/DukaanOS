import { useCallback, useEffect, useRef, useState } from "react";
import type { Schemas } from "../../../lib/api/client";
import { formatINR, formatQuantity } from "../../../lib/format";
import { recognizeFrame } from "./api";
import { CameraError, captureFrame, openCamera, stopStream } from "./camera";
import { DetectionOverlay, MockNotice, describeDetection } from "./DetectionOverlay";
import { DetectionReview } from "./DetectionReview";
import { initialRows, type Product, type ReviewRow } from "./review";

export const SCAN_INTERVAL_MS = 1500;

type Phase = "starting" | "live" | "reading" | "review" | "error";

type Props = {
  products: Product[];
  /** Adds the confirmed items to the existing Counter cart. */
  onConfirm: (items: Schemas["ConfirmedItem"][]) => Promise<unknown>;
  onClose: () => void;
  scanIntervalMs?: number;
};

/**
 * Live Vision Counter: camera -> periodic frame recognition -> boxes with name and price.
 * "Read the whole counter" freezes one fresh read into the shared review step; only
 * "Add N to bill" touches the cart (via the existing recognized-items -> add_item path).
 */
export function LiveVision({ products, onConfirm, onClose, scanIntervalMs = SCAN_INTERVAL_MS }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextSequence = useRef(0);
  const latestShown = useRef(-1);

  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("starting");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [result, setResult] = useState<Schemas["VisionResult"] | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [added, setAdded] = useState(false);

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

  // Live loop: one frame at a time, newest result wins, stops as soon as we leave "live".
  useEffect(() => {
    if (phase !== "live") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await scanOnce();
        if (!stopped && next && (next.sequence ?? 0) > latestShown.current) {
          latestShown.current = next.sequence ?? 0;
          setResult(next);
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

  async function readWholeCounter() {
    setPhase("reading");
    setAdded(false);
    try {
      const read = await scanOnce();
      if (!read) throw new Error("The camera has no picture yet. Try again in a moment.");
      latestShown.current = Math.max(latestShown.current, read.sequence ?? 0);
      setResult(read);
      setRows(initialRows(read.detections));
      setScanError(null);
      videoRef.current?.pause();
      setPhase("review");
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Recognition failed");
      setPhase("live");
    }
  }

  function backToLive() {
    setRows([]);
    if (videoRef.current) resume(videoRef.current);
    setPhase("live");
  }

  function stop() {
    stopStream(streamRef.current);
    streamRef.current = null;
    onClose();
  }

  const reviewing = phase === "review";
  const shown = reviewing ? rows.map((r) => r.detection) : (result?.detections ?? []);

  return (
    <section aria-label="Vision counter" className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-medium text-slate-900">
          Vision counter{" "}
          {phase === "live" && <span className="ml-1 text-xs font-normal text-emerald-700">● Live</span>}
          {reviewing && <span className="ml-1 text-xs font-normal text-slate-500">Paused for review</span>}
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
          <video
            ref={videoRef}
            aria-label="Live camera"
            muted
            playsInline
            className="block min-h-48 w-full"
          />
          <DetectionOverlay detections={shown} detailed />
          {phase === "starting" && (
            <p
              role="status"
              className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white"
            >
              Starting camera… Allow camera access if your browser asks.
            </p>
          )}
        </div>
      )}

      {result?.is_mock && (
        <div className="mt-3">
          <MockNotice>
            Demo live recognizer (<code>{result.provider}</code>): not real AI. It ignores the camera picture and cycles
            through fixed sample scenes, so products appear and disappear between scans.
          </MockNotice>
        </div>
      )}
      {scanError && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {scanError}
        </p>
      )}
      {added && phase === "live" && (
        <p role="status" className="mt-3 text-sm text-emerald-700">
          Added to the bill. Keep scanning or read the counter again.
        </p>
      )}

      {phase !== "error" && !reviewing && (
        <>
          <h3 className="mb-1 mt-4 text-sm font-medium text-slate-500">On the counter now</h3>
          {shown.length === 0 ? (
            <p className="text-sm text-slate-400">{phase === "live" ? "Nothing detected yet." : "—"}</p>
          ) : (
            <ul aria-label="Seen on counter" className="text-sm">
              {shown.map((d) => {
                const { title, price, note } = describeDetection(d);
                return (
                  <li key={d.id} className="flex justify-between py-0.5">
                    <span>
                      {title} <span className="text-slate-400">× {formatQuantity(d.quantity)}</span>
                      {note && <span className="text-amber-700"> · {note}</span>}
                    </span>
                    <span className="text-slate-600">{price ? formatINR(price) : "—"}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            disabled={phase !== "live"}
            onClick={() => void readWholeCounter()}
            className="mt-4 w-full rounded-md bg-emerald-600 py-2.5 font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {phase === "reading" ? "Reading the counter…" : "Read the whole counter"}
          </button>
          <p className="mt-1 text-center text-xs text-slate-500">Nothing is added to the bill until you confirm.</p>
        </>
      )}

      {reviewing && (
        <div className="mt-4">
          <DetectionReview
            rows={rows}
            setRows={setRows}
            products={products}
            emptyText="Nothing to add from this read."
            onConfirm={onConfirm}
            onConfirmed={() => {
              setAdded(true);
              backToLive();
            }}
          />
          <button type="button" onClick={backToLive} className="mt-2 text-sm text-slate-500 hover:text-slate-800">
            Discard and keep scanning
          </button>
        </div>
      )}
    </section>
  );
}

function resume(video: HTMLVideoElement) {
  try {
    void video.play()?.catch(() => {});
  } catch {
    // Autoplay can be refused; the stream still attaches and frames still capture.
  }
}
