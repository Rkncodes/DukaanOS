import { describe, expect, it } from "vitest";
import type { Schemas } from "../../../lib/api/client";
import { LIVE, coke, det, lays, maggi, parle, pepsi } from "./testing";
import { MISS_LIMIT, iou, markCommitted, remainingToAdd, trackKeys, updateTracks, type Track } from "./tracking";

const cartWith = (...lines: [string, number][]): Schemas["CartRead"] =>
  ({ items: lines.map(([product_id, q]) => ({ product_id, quantity: q.toFixed(3) })) }) as Schemas["CartRead"];

const frames = (...scenes: Schemas["Detection"][][]) => scenes.reduce<Track[]>((t, s) => updateTracks(t, s), []);

describe("trackKeys", () => {
  it("keys by product, label or best guess, and separates identical products left to right", () => {
    const left = det("a", "Maggi", "matched", { product: maggi, bbox: { x: 0.1, y: 0, width: 0.1, height: 0.1 } });
    const right = det("b", "Maggi", "matched", { product: maggi, bbox: { x: 0.6, y: 0, width: 0.1, height: 0.1 } });
    expect(trackKeys([right, left])).toEqual([`product:${maggi.id}#2`, `product:${maggi.id}`]);
    expect(trackKeys([LIVE.parle, LIVE.drink, LIVE.unknown])).toEqual([
      `maybe:${parle.id}`,
      "seen:cold drink 750ml",
      "seen:red toothpaste tube",
    ]);
  });
});

describe("updateTracks", () => {
  it("marks products new, then present, then leaving, then drops them", () => {
    let tracks = frames([LIVE.maggi]);
    expect(tracks.map((t) => [t.key, t.status])).toEqual([[`product:${maggi.id}`, "new"]]);

    tracks = updateTracks(tracks, [LIVE.maggi, LIVE.lays]);
    expect(tracks.map((t) => t.status)).toEqual(["present", "new"]);
    expect(tracks[0].seenFrames).toBe(2);

    tracks = updateTracks(tracks, [LIVE.lays]);
    expect(tracks.map((t) => [t.detection.label, t.status])).toEqual([
      ["Lays Classic Salted", "present"],
      ["Maggi 2-Minute Noodles", "leaving"],
    ]);
    for (let i = 1; i < MISS_LIMIT; i++) tracks = updateTracks(tracks, [LIVE.lays]);
    expect(tracks.map((t) => t.detection.label)).toEqual(["Lays Classic Salted"]);
  });

  it("a product seen in many frames stays one track and keeps merchant state", () => {
    let tracks = frames([LIVE.drink]);
    tracks = tracks.map((t) => ({ ...t, chosen: pepsi, committed: 1 }));
    for (let i = 0; i < 10; i++) tracks = updateTracks(tracks, [LIVE.drink]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ chosen: pepsi, committed: 1, seenFrames: 11, status: "present" });
  });
});

describe("remainingToAdd / markCommitted", () => {
  it("never offers the same packet twice across repeated frames", () => {
    let tracks = frames([LIVE.maggi]);
    expect(remainingToAdd(tracks[0], null)).toBe(1);

    tracks = markCommitted(tracks, new Map([[tracks[0].key, 1]]), null);
    const cart = cartWith([maggi.id, 1]);
    for (let i = 0; i < 5; i++) tracks = updateTracks(tracks, [LIVE.maggi]);
    expect(remainingToAdd(tracks[0], cart)).toBe(0);
  });

  it("offers only the extra quantity when a second packet appears", () => {
    let tracks = markCommitted(frames([LIVE.maggi]), new Map([[`product:${maggi.id}`, 1]]), null);
    tracks = updateTracks(tracks, [LIVE.maggi2]);
    expect(remainingToAdd(tracks[0], cartWith([maggi.id, 1]))).toBe(1);
  });

  it("becomes addable again if the line was removed from the bill", () => {
    const tracks = markCommitted(frames([LIVE.maggi]), new Map([[`product:${maggi.id}`, 1]]), null);
    expect(remainingToAdd(tracks[0], cartWith())).toBe(1);
  });

  it("counts other bill lines as context, not as this track's commits", () => {
    const tracks = frames([LIVE.lays]);
    expect(remainingToAdd(tracks[0], cartWith([lays.id, 3]))).toBe(1); // e.g. scanned by barcode earlier
  });

  it("undecided, unknown and leaving products are never addable", () => {
    const tracks = frames([LIVE.drink, LIVE.parle, LIVE.unknown]);
    expect(tracks.map((t) => remainingToAdd(t, null))).toEqual([0, 0, 0]);
    const chosen = { ...tracks[0], chosen: coke };
    expect(remainingToAdd(chosen, null)).toBe(1);
    expect(remainingToAdd({ ...chosen, status: "leaving" }, null)).toBe(0);
  });
});

describe("one physical packet is one track, even when its reading changes", () => {
  const here = { x: 0.3, y: 0.2, width: 0.3, height: 0.4 };
  const nudged = { x: 0.32, y: 0.21, width: 0.3, height: 0.4 }; // the same packet, held a little differently
  const elsewhere = { x: 0.7, y: 0.5, width: 0.2, height: 0.3 };
  const matched = det("d0", maggi.name, "matched", { product: maggi, bbox: here });
  const unknown = det("d0", "Unknown product", "unmatched", { confidence: null, bbox: nudged });
  const unsure = det("d0", maggi.name, "low_confidence", { candidates: [maggi], confidence: 0.5, bbox: nudged });

  it("measures box overlap", () => {
    expect(iou(here, here)).toBeCloseTo(1);
    expect(iou(here, nudged)).toBeGreaterThan(0.8);
    expect(iou(here, elsewhere)).toBe(0);
    expect(iou(here, null)).toBe(0);
  });

  it("a one-frame weak reading of a matched packet does not create a second row or lose its state", () => {
    let tracks = markCommitted(frames([matched]), new Map([[`product:${maggi.id}`, 1]]), null);
    for (const flicker of [unknown, unsure]) {
      const held = updateTracks(tracks, [flicker]);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ key: `product:${maggi.id}`, status: "present", committed: 1 });
      expect(held[0].detection).toMatchObject({ match: "matched", bbox: nudged }); // identity kept, box follows
      tracks = updateTracks(held, [matched]);
      expect(tracks).toHaveLength(1);
      expect(tracks[0]).toMatchObject({ missedFrames: 0, committed: 1 });
      expect(remainingToAdd(tracks[0], cartWith([maggi.id, 1]))).toBe(0); // never offered twice
    }
  });

  it("a weak reading that persists replaces the matched one instead of sitting beside it", () => {
    let tracks = frames([matched]);
    for (let i = 0; i < MISS_LIMIT; i++) tracks = updateTracks(tracks, [unknown]);
    expect(tracks.map((t) => [t.key, t.detection.match])).toEqual([["seen:unknown product", "unmatched"]]);
  });

  it("swapping the packet for another product in the same place changes the track at once", () => {
    const other = det("d0", lays.name, "matched", { product: lays, bbox: nudged });
    const tracks = updateTracks(markCommitted(frames([matched]), new Map([[`product:${maggi.id}`, 1]]), null), [other]);
    expect(tracks.map((t) => [t.key, t.status, t.committed])).toEqual([[`product:${lays.id}`, "new", 0]]);
  });

  it("an unsure packet that becomes recognized keeps what was already added for it", () => {
    let tracks: Track[] = frames([unsure]).map((t) => ({ ...t, chosen: maggi, committed: 1 }));
    tracks = updateTracks(tracks, [matched]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ key: `product:${maggi.id}`, status: "present", committed: 1 });
    expect(remainingToAdd(tracks[0], cartWith([maggi.id, 1]))).toBe(0);
  });

  it("a second packet somewhere else is still a second track", () => {
    const second = det("d1", maggi.name, "matched", { product: maggi, bbox: elsewhere });
    const tracks = updateTracks(frames([matched]), [matched, second]);
    expect(tracks.map((t) => [t.key, t.status])).toEqual([
      [`product:${maggi.id}`, "present"],
      [`product:${maggi.id}#2`, "new"],
    ]);
  });
});
