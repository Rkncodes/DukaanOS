/** The barcodes printed on retail packs, and ITF for the 14-digit codes on boxes and cartons. */
export const RETAIL_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "itf"] as const;

/**
 * ITF has no fixed length of its own and a partly seen ITF symbol can read as a shorter number, so only
 * the retail form is accepted: ITF-14, exactly 14 digits. This is a rule about the symbol, not about the
 * catalogue: whatever is read is still looked up exactly as read.
 */
export function isAcceptable(format: string, value: string): boolean {
  return format !== "itf" || /^\d{14}$/.test(value);
}
