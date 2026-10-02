/**
 * Thin wrapper over the browser MediaDevices API. Kept separate so the Vision Counter UI
 * never touches camera/canvas APIs directly (and tests can replace frame capture).
 */

export type CameraProblem = "unsupported" | "denied" | "not_found" | "failed";

export class CameraError extends Error {
  readonly problem: CameraProblem;

  constructor(problem: CameraProblem, message: string) {
    super(message);
    this.name = "CameraError";
    this.problem = problem;
  }
}

export async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError("unsupported", "This browser can't open the camera here. Use a current browser on localhost or HTTPS.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    const name = e instanceof DOMException || e instanceof Error ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new CameraError(
        "denied",
        "Camera permission was denied. Allow camera access for this site in your browser, then try again.",
      );
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new CameraError("not_found", "No camera was found on this device.");
    }
    throw new CameraError("failed", "Could not start the camera. Close other apps using it and try again.");
  }
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Current video frame as a JPEG (downscaled), or null if the video has no frame yet. */
export async function captureFrame(video: HTMLVideoElement, maxWidth = 960): Promise<Blob | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return null;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
}

/** The part of the current video frame inside `box` (normalized 0..1) as a JPEG, or null if there is no frame. */
export async function captureRegion(
  video: HTMLVideoElement,
  box: { x: number; y: number; width: number; height: number },
): Promise<Blob | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return null;
  const sx = Math.max(0, box.x) * video.videoWidth;
  const sy = Math.max(0, box.y) * video.videoHeight;
  const sw = Math.min(1 - Math.max(0, box.x), box.width) * video.videoWidth;
  const sh = Math.min(1 - Math.max(0, box.y), box.height) * video.videoHeight;
  if (sw < 1 || sh < 1) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
}
