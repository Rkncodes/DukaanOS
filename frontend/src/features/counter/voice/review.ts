import type { Schemas } from "../../../lib/api/client";
import { api, unwrap } from "../../../lib/api/client";
import { isValidQuantity } from "../vision/review";

export type VoiceLine = Schemas["VoiceLine"];
export type Product = Schemas["ProductRead"];

export type VoiceResult = Schemas["VoiceResult"];
type CartItem = Schemas["CartItemRead"];

/**
 * Transcript -> what was asked, with its items matched to this merchant's catalogue (or, for
 * "remove" and "change the quantity", to the open bill). Read-only: no cart is touched.
 */
export function parseVoice({ transcript, cartId }: { transcript: string; cartId: string | null }) {
  return unwrap(api.POST("/api/v1/voice/parse", { body: cartId ? { transcript, cart_id: cartId } : { transcript } }));
}

/** One thing a spoken "remove" or "change the quantity" would do to the bill, for the merchant to confirm. */
export type BillChange = {
  line: VoiceLine;
  /** The bill's lines it could mean: one when it is clear, several to choose from, none when it is not on the bill. */
  items: CartItem[];
  /** The new quantity for "change the quantity"; null when none was heard. */
  quantity: string | null;
};

/** Which lines of the open bill a spoken command is about. Only lines that are on the bill are ever offered. */
export function billChanges(result: VoiceResult, cartItems: CartItem[]): BillChange[] {
  return result.lines.map((line) => {
    const products = line.product ? [line.product.id] : line.candidates.map((c) => c.id);
    return {
      line,
      items: cartItems.filter((item) => products.includes(item.product_id)),
      quantity: line.quantity === null ? null : String(Number(line.quantity)),
    };
  });
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
