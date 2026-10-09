import type { ReactNode } from "react";
import { translate, useTranslation } from "../../../i18n";
import { formatINR } from "../../../lib/format";
import type { Detection } from "./review";

/**
 * What to call a detection, and its price, given how it matched this merchant's catalog. What the
 * recogniser read (`label`, `barcode`) and product names are data and stay as they are; the notes are
 * in the app's language (callers are components that re-render when it changes).
 */
export function describeDetection(d: Detection): { title: string; price: string | null; note: string | null } {
  const seen = d.label ?? d.barcode ?? translate("vision.item");
  switch (d.match) {
    case "matched":
      return { title: d.product!.name, price: d.product!.price, note: null };
    case "low_confidence":
      return { title: d.candidates[0].name, price: d.candidates[0].price, note: translate("vision.unsure") };
    case "ambiguous":
      return { title: seen, price: null, note: translate("vision.options", { count: d.candidates.length }) };
    default:
      return { title: seen, price: null, note: translate("vision.notInCatalog") };
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
  const { t } = useTranslation();
  return (
    <div className="pointer-events-none absolute inset-0" aria-label={t("vision.detections")} role="list">
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
            aria-label={t("vision.box", { index: i + 1, title })}
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
