import type { ReactNode } from "react";
import { formatINR } from "../../../lib/format";
import type { Detection } from "./review";

/** What to call a detection, and its price, given how it matched this merchant's catalog. */
export function describeDetection(d: Detection): { title: string; price: string | null; note: string | null } {
  const seen = d.label ?? d.barcode ?? "item";
  switch (d.match) {
    case "matched":
      return { title: d.product!.name, price: d.product!.price, note: null };
    case "low_confidence":
      return { title: d.candidates[0].name, price: d.candidates[0].price, note: "unsure" };
    case "ambiguous":
      return { title: seen, price: null, note: `${d.candidates.length} options` };
    default:
      return { title: seen, price: null, note: "not in catalog" };
  }
}

const TONE: Record<Detection["match"], string> = {
  matched: "border-emerald-500 bg-emerald-600",
  low_confidence: "border-amber-400 bg-amber-500",
  ambiguous: "border-amber-400 bg-amber-500",
  unmatched: "border-slate-400 bg-slate-500",
};

export type BoxAnnotation = { tag?: string; faded?: boolean };

/**
 * Bounding boxes over an image/video. Coordinates are normalized (0..1), so the parent must be
 * `relative` and sized exactly like the media (e.g. <img|video className="block w-full">).
 */
export function DetectionOverlay({
  detections,
  detailed = false,
  annotate,
}: {
  detections: Detection[];
  detailed?: boolean;
  /** Optional per-box status from the caller (e.g. live tracking: "in bill", "leaving"). */
  annotate?: (detection: Detection, index: number) => BoxAnnotation;
}) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-label="Detections" role="list">
      {detections.map((d, i) => {
        if (!d.bbox) return null;
        const { title, price, note } = describeDetection(d);
        const confidence = d.confidence === null ? null : `${Math.round(d.confidence * 100)}%`;
        const [border, badge] = TONE[d.match].split(" ");
        const { tag, faded } = annotate?.(d, i) ?? {};
        return (
          <div
            key={d.id}
            role="listitem"
            aria-label={`Box ${i + 1}: ${title}`}
            data-match={d.match}
            data-faded={faded ? "true" : undefined}
            className={`absolute border-2 transition-opacity ${border} ${faded ? "border-dashed opacity-40" : ""}`}
            style={{
              left: `${d.bbox.x * 100}%`,
              top: `${d.bbox.y * 100}%`,
              width: `${d.bbox.width * 100}%`,
              height: `${d.bbox.height * 100}%`,
            }}
          >
            <span className={`absolute bottom-full left-[-2px] whitespace-nowrap px-1 text-xs text-white ${badge}`}>
              {i + 1}
              {detailed && (
                <>
                  {" "}
                  {title}
                  {price && ` · ${formatINR(price)}`}
                  {note && ` · ${note}`}
                  {confidence && ` · ${confidence}`}
                </>
              )}
              {tag && ` · ${tag}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function MockNotice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="note">
      {children}
    </p>
  );
}
