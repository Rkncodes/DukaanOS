import type { Schemas } from "../../../lib/api/client";
import { api, unwrap } from "../../../lib/api/client";
import { isValidQuantity } from "../vision/review";

export type VoiceLine = Schemas["VoiceLine"];
export type Product = Schemas["ProductRead"];

/** Transcript -> spoken items matched to this merchant's catalogue. Read-only: no cart is touched. */
export function parseVoice(transcript: string) {
  return unwrap(api.POST("/api/v1/voice/parse", { body: { transcript } }));
}

/** One spoken item under review. `product` is what will be added; null means "not added". */
export type VoiceRow = {
  line: VoiceLine;
  product: Product | null;
  quantity: string; // "" when no reliable quantity was said: the merchant must enter it
};

/** Only single, confident matches start selected; a quantity is never assumed. */
export function initialRows(lines: VoiceLine[]): VoiceRow[] {
  return lines.map((line) => ({
    line,
    product: line.match === "matched" ? line.product : null,
    quantity: line.quantity === null ? "" : String(Number(line.quantity)),
  }));
}

export type VoicePlan = {
  items: Schemas["ConfirmedItem"][];
  skipped: number; // items with no product chosen: never added
  missingQuantity: number; // chosen items still waiting for a valid quantity
};

export function voicePlan(rows: VoiceRow[]): VoicePlan {
  const chosen = rows.filter((r) => r.product !== null);
  return {
    items: chosen.map((r) => ({ product_id: r.product!.id, quantity: r.quantity.trim() })),
    skipped: rows.length - chosen.length,
    missingQuantity: chosen.filter((r) => !isValidQuantity(r.quantity)).length,
  };
}
