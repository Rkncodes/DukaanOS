import { api, unwrap } from "../../../lib/api/client";

/** Multipart helper: openapi-fetch leaves Content-Type to the browser for FormData. */
function form(fields: Record<string, Blob | string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/** Single photo -> detections (Phase 1, "Add from photo"). */
export function recognizePhoto(file: File) {
  return unwrap(
    api.POST("/api/v1/vision/recognize", {
      body: { image: file as unknown as string },
      bodySerializer: (body) => form({ image: body.image as unknown as Blob }),
    }),
  );
}

/** One live camera frame -> detections. `sequence` lets us drop out-of-order replies. */
export function recognizeFrame(frame: Blob, sequence: number) {
  return unwrap(
    api.POST("/api/v1/vision/frames", {
      body: { image: frame as unknown as string, sequence },
      bodySerializer: (body) =>
        form({ image: new File([body.image as unknown as Blob], "frame.jpg", { type: "image/jpeg" }), sequence: String(body.sequence ?? 0) }),
    }),
  );
}
