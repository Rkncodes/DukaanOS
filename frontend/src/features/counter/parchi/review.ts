import type { Schemas } from "../../../lib/api/client";
import { api, unwrap } from "../../../lib/api/client";
import { isValidQuantity } from "../vision/review";

export type ParchiLine = Schemas["ParchiLine"];
export type Product = Schemas["ProductRead"];

/** Photo of a parchi -> its lines matched to this merchant's catalogue. Read-only: no cart is touched. */
export function readParchi(file: File) {
  return unwrap(
    api.POST("/api/v1/parchi/read", {
      body: { image: file as unknown as string },
      bodySerializer: (body) => {
        const data = new FormData();
        data.append("image", body.image as unknown as Blob);
        return data;
      },
    }),
  );
}

/** One parchi line under review. `product` is what will be added; null means "not added". */
export type ParchiRow = {
  line: ParchiLine;
  product: Product | null;
  quantity: string; // "" when the parchi gave no reliable quantity: the merchant must enter it
};

/** Only single, confident matches start selected; a quantity is never assumed. */
export function initialRows(lines: ParchiLine[]): ParchiRow[] {
  return lines.map((line) => ({
    line,
    product: line.match === "matched" ? line.product : null,
    quantity: line.quantity === null ? "" : String(Number(line.quantity)),
  }));
}

export type ParchiPlan = {
  items: Schemas["ConfirmedItem"][];
  skipped: number; // lines with no product chosen: never added
  missingQuantity: number; // chosen lines still waiting for a valid quantity
};

export function parchiPlan(rows: ParchiRow[]): ParchiPlan {
  const chosen = rows.filter((r) => r.product !== null);
  return {
    items: chosen.map((r) => ({ product_id: r.product!.id, quantity: r.quantity.trim() })),
    skipped: rows.length - chosen.length,
    missingQuantity: chosen.filter((r) => !isValidQuantity(r.quantity)).length,
  };
}
