import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../app/icons";
import { useTranslation } from "../../../i18n";
import { CameraError, openCamera, stopStream } from "../vision/camera";
import type { Decoder } from "./scanner";

/** How often a frame is looked at. Decoding is local and fast; this keeps the laptop cool. */
export const SCAN_EVERY_MS = 200;

type Phase =
  | { name: "off" }
  | { name: "starting" }
  | { name: "scanning"; hint?: string }
  /** A barcode was read and handed over. Nothing more is read until the merchant asks for the next one. */
  | { name: "read"; code: string }
  | { name: "error"; message: string };

type Props = {
  /** A barcode the camera read, exactly as printed. Resolves once it has been dealt with (added or refused). */
  onDetected: (code: string) => Promise<void>;
  scanEveryMs?: number;
};

/**
 * Scanning with the device's camera. The camera is only opened when the merchant presses Start camera,
 * frames are decoded in the browser (see scanner.ts), and every track is stopped when scanning stops or
 * this leaves the page. One read is one product: scanning pauses on a barcode until "Scan next product".
 */
export function CameraScan({ onDetected, scanEveryMs = SCAN_EVERY_MS }: Props) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ name: "off" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const decoderRef = useRef<Decoder | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Changes whenever the camera is started or stopped, so work begun for an earlier session is dropped. */
  const sessionRef = useRef(0);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  function release() {
    sessionRef.current += 1;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    stopStream(streamRef.current); // every track: the camera light goes off
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  // Leaving the page (or the Counter mode) must never leave the camera on.
  useEffect(() => release, []);

  function look(session: number) {
    timerRef.current = setTimeout(async () => {
      const video = videoRef.current;
      const decode = decoderRef.current;
      if (session !== sessionRef.current || !video || !decode) return;
      let reading;
      try {
        reading = await decode(video);
      } catch {
        if (session !== sessionRef.current) return;
        release();
        setPhase({ name: "error", message: t("barcode.readerStopped") });
        return;
      }
      if (session !== sessionRef.current) return;
      if (reading.kind === "one") {
        setPhase({ name: "read", code: reading.code }); // paused: this barcode is not read a second time
        await onDetectedRef.current(reading.code);
        return;
      }
      if (reading.kind === "several") setPhase({ name: "scanning", hint: t("barcode.severalInView") });
      look(session);
    }, scanEveryMs);
  }

  async function start() {
    release();
    const session = sessionRef.current;
    setPhase({ name: "starting" });
    try {
      const stream = await openCamera();
      if (session !== sessionRef.current) {
        stopStream(stream); // stopped or left while the browser was still asking for permission
        return;
      }
      streamRef.current = stream;
      // The camera was unplugged, or another app took it.
      stream.getTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          if (session !== sessionRef.current) return;
          release();
          setPhase({ name: "error", message: t("barcode.cameraStopped") });
        }),
      );
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {}); // autoplay rules: the frame loop below copes with a paused video
      }
      decoderRef.current ??= (await import("./scanner")).createDecoder();
      if (session !== sessionRef.current) return;
      setPhase({ name: "scanning" });
      look(session);
    } catch (error) {
      if (session !== sessionRef.current) return;
      release();
      setPhase({
        name: "error",
        message:
          error instanceof CameraError
            ? t("barcode.cameraProblem", { message: error.message })
            : t("barcode.readerNotLoaded"),
      });
    }
  }

  function stop() {
    release();
    setPhase({ name: "off" });
  }

  function next() {
    setPhase({ name: "scanning" });
    look(sessionRef.current);
  }

  const live = phase.name === "scanning" || phase.name === "read" || phase.name === "starting";

  return (
    <div aria-label={t("barcode.cameraScanner")} role="group">
      {/* The video element stays mounted so the stream can be attached before the first frame shows. */}
      <div className={live ? "relative overflow-hidden rounded-xl bg-slate-900" : "hidden"}>
        <video ref={videoRef} aria-label={t("barcode.camera")} muted playsInline className="block max-h-[22rem] min-h-56 w-full object-cover" />
        {/* The guide: hold the barcode inside it. Reading works anywhere in the picture. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className={`h-2/5 w-3/4 rounded-lg border-2 ${
              phase.name === "read" ? "border-emerald-400" : "border-white/80"
            } shadow-[0_0_0_100vmax_rgba(15,23,42,0.35)]`}
          >
            {phase.name === "scanning" && <div className="mx-3 mt-[20%] h-0.5 bg-red-500/80" />}
          </div>
        </div>
        {live && (
          <p aria-label={t("barcode.cameraStatus")} className="absolute inset-x-0 bottom-0 bg-slate-900/70 px-3 py-2 text-center text-sm text-white">
            {phase.name === "starting" && t("camera.starting")}
            {phase.name === "scanning" && (phase.hint ?? t("barcode.hold"))}
            {phase.name === "read" && t("barcode.read", { code: phase.code })}
          </p>
        )}
      </div>

      {phase.name === "error" && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {phase.message}
        </p>
      )}

      <div className={`flex flex-wrap items-center gap-2 ${live || phase.name === "error" ? "mt-3" : ""}`}>
        {!live && (
          <button
            type="button"
            onClick={start}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            <Icon name="camera" className="h-5 w-5" />
            {phase.name === "error" ? t("barcode.tryCamera") : t("barcode.startCamera")}
          </button>
        )}
        {phase.name === "read" && (
          <button type="button" onClick={next} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            {t("barcode.scanNext")}
          </button>
        )}
        {live && (
          <button type="button" onClick={stop} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            {t("camera.stop")}
          </button>
        )}
        {!live && phase.name !== "error" && (
          <span className="text-sm text-slate-500">{t("barcode.cameraNote")}</span>
        )}
      </div>
    </div>
  );
}
