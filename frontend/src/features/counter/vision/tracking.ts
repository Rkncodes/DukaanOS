import type { Schemas } from "../../../lib/api/client";
import type { Detection, Product } from "./review";

/**
 * Minimal, deterministic tracking for the live Vision Counter.
 *
 * Frames are independent; a *track* is "this product on the counter" across frames, so a
 * packet seen in 10 frames is one thing the merchant can add once. Identity is the matched
 * catalog product (or the label for undecided/unknown items); identical products in one
 * frame are told apart by left-to-right order. A real detector's reading of one packet can
 * flicker between frames (matched, then unsure, then matched), so a detection with a new
 * identity that sits where an existing track was is treated as that same physical packet
 * (box overlap), never as a second one. Nothing outside this file depends on how identity is decided.
 */

/** Frames a product may be missing before its track is dropped (absorbs detector flicker). */
export const MISS_LIMIT = 2;

/** Box overlap (IoU) from which two sightings are the same physical packet. */
export const SAME_PLACE_IOU = 0.5;

export type TrackStatus = "new" | "present" | "leaving";

export type Track = {
  key: string;
  detection: Detection; // latest sighting
  status: TrackStatus;
  seenFrames: number;
  missedFrames: number;
  chosen: Product | null; // merchant's pick for an ambiguous / low-confidence detection
  committed: number; // quantity this track has already added to the bill
};

function identity(d: Detection): string {
  if (d.match === "matched" && d.product) return `product:${d.product.id}`;
  if (d.match === "low_confidence" && d.candidates[0]) return `maybe:${d.candidates[0].id}`;
  return `seen:${(d.label ?? d.barcode ?? "item").trim().toLowerCase()}`;
}

/** Stable keys for one frame's detections (same order as the input). */
export function trackKeys(detections: Detection[]): string[] {
  const order = detections
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (a.d.bbox?.x ?? 0) - (b.d.bbox?.x ?? 0) || a.i - b.i);
  const seen = new Map<string, number>();
  const keys: string[] = new Array(detections.length);
  for (const { d, i } of order) {
    const base = identity(d);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keys[i] = n === 1 ? base : `${base}#${n}`;
  }
  return keys;
}

type Box = NonNullable<Detection["bbox"]>;

export function iou(a: Box | null, b: Box | null): number {
  if (!a || !b) return 0;
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/** A track the merchant can bill: matched by vision, or decided by the merchant. */
const decided = (t: Track) => t.detection.match === "matched" || t.chosen !== null;

/** Fold one frame into the tracks. Merchant state (chosen, committed) follows the track. */
export function updateTracks(previous: Track[], detections: Detection[]): Track[] {
  const keys = trackKeys(detections);
  const open = new Map(previous.map((t) => [t.key, t]));
  const next: (Track | null)[] = detections.map((detection, i) => {
    const old = open.get(keys[i]);
    if (!old) return null;
    open.delete(keys[i]);
    return { ...old, detection, status: "present", seenFrames: old.seenFrames + 1, missedFrames: 0 };
  });
  // Detections with a new identity: is one of the unclaimed tracks the same packet, read differently?
  detections.forEach((detection, i) => {
    if (next[i]) return;
    const fresh: Track = { key: keys[i], detection, status: "new", seenFrames: 1, missedFrames: 0, chosen: null, committed: 0 };
    let same: Track | undefined;
    let best = SAME_PLACE_IOU;
    for (const t of open.values()) {
      const overlap = iou(t.detection.bbox, detection.bbox);
      if (overlap >= best) [same, best] = [t, overlap];
    }
    if (!same) {
      next[i] = fresh;
      return;
    }
    open.delete(same.key); // either way: one packet, one row
    if (decided(same) && detection.match !== "matched" && same.missedFrames + 1 < MISS_LIMIT) {
      // A decided packet that reads worse for a frame keeps its identity (detector flicker).
      const held = { ...same.detection, bbox: detection.bbox };
      next[i] = { ...same, detection: held, status: "present", missedFrames: same.missedFrames + 1 };
    } else if (detection.product && billProduct(same)?.id === detection.product.id) {
      // Now recognized as the product this packet was already billed as: keep what it committed.
      next[i] = { ...fresh, status: "present", seenFrames: same.seenFrames + 1, committed: same.committed };
    } else {
      next[i] = fresh; // a different reading (or a second weak one in a row) replaces the old one
    }
  });
  const tracks = next as Track[];
  for (const old of open.values()) {
    if (old.missedFrames + 1 < MISS_LIMIT) tracks.push({ ...old, status: "leaving", missedFrames: old.missedFrames + 1 });
  }
  return tracks;
}

/** The catalog product this track would bill, if decided (never for unmatched/undecided). */
export function billProduct(track: Track): Product | null {
  return track.detection.match === "matched" ? track.detection.product : track.chosen;
}

export function quantityInBill(cart: Schemas["CartRead"] | null, productId: string): number {
  return (cart?.items ?? []).filter((i) => i.product_id === productId).reduce((s, i) => s + Number(i.quantity), 0);
}

/**
 * How much of this track can still be added. A track only counts what *it* committed, capped by
 * what is actually in the bill (if the merchant removed the line, it becomes addable again).
 * Leaving tracks cannot be added: the product is no longer in view.
 */
export function remainingToAdd(track: Track, cart: Schemas["CartRead"] | null): number {
  const product = billProduct(track);
  if (!product || track.status === "leaving") return 0;
  const committed = Math.min(track.committed, quantityInBill(cart, product.id));
  return Math.max(0, Number(track.detection.quantity) - committed);
}

/** After a successful commit of `quantity`, record it on the track (by key; it may have left). */
export function markCommitted(
  tracks: Track[],
  commits: Map<string, number>,
  cart: Schemas["CartRead"] | null,
): Track[] {
  return tracks.map((t) => {
    const added = commits.get(t.key);
    if (added === undefined) return t;
    const product = billProduct(t);
    const before = product ? Math.min(t.committed, quantityInBill(cart, product.id)) : 0;
    return { ...t, committed: before + added };
  });
}
