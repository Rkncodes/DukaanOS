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
