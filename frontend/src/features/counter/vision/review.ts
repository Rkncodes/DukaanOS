import type { Schemas } from "../../../lib/api/client";

export type Detection = Schemas["Detection"];
export type Product = Schemas["ProductRead"];

/** Mirrors backend app.modules.vision.image limits so bad files fail before uploading. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function imageFileError(file: File): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return "Choose a JPEG, PNG or WebP photo.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_IMAGE_BYTES) return "Photo is larger than 8 MB.";
  return null;
}

/** One detection under review. `product` is what will be added; null means "not added". */
export type ReviewRow = {
  detection: Detection;
  product: Product | null;
  quantity: string;
};

/** Only confident, single matches start selected. Everything else waits for the merchant. */
export function initialRows(detections: Detection[]): ReviewRow[] {
  return detections.map((detection) => ({
    detection,
    product: detection.match === "matched" ? detection.product : null,
    quantity: String(Number(detection.quantity)),
  }));
}

export function isValidQuantity(quantity: string): boolean {
  return /^\d+(\.\d{1,3})?$/.test(quantity.trim()) && Number(quantity) > 0;
}

export type ConfirmPlan = {
  items: Schemas["ConfirmedItem"][];
  skipped: number; // rows with no product chosen: never added
  invalid: boolean; // some chosen row has a bad quantity
};

export function confirmPlan(rows: ReviewRow[]): ConfirmPlan {
  const chosen = rows.filter((r) => r.product !== null);
  return {
    items: chosen.map((r) => ({ product_id: r.product!.id, quantity: r.quantity.trim() })),
    skipped: rows.length - chosen.length,
    invalid: chosen.some((r) => !isValidQuantity(r.quantity)),
  };
}
