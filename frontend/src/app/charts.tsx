import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "../i18n";

/**
 * Two hand-rolled chart primitives (no charting dependency, matching the project's
 * hand-rolled icon set in app/icons.tsx): a single-series trend line and a ranked
 * horizontal bar list. Both follow the dataviz skill: one sequential hue (the app's
 * own emerald brand color), thin marks, hairline gridlines, a hover layer, and a
 * "View as table" toggle as the accessibility twin of the chart.
 */

export type ChartPoint = { label: string; value: number };

const MARK = "#059669"; // emerald-600, the app's existing brand/action color
const GRID = "#e2e8f0"; // slate-200
const AXIS_TEXT = "#64748b"; // slate-500 — text never wears the data color

function TableToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onToggle} className="mt-2 text-xs text-slate-500 hover:text-emerald-700 hover:underline">
      {show ? t("charts.hideTable") : t("charts.viewTable")}
    </button>
  );
}

function DataTable({ data, formatValue }: { data: ChartPoint[]; formatValue: (v: number) => string }) {
  const { t } = useTranslation();
  return (
    <table className="mt-2 w-full text-left text-xs">
      <thead className="text-slate-500">
        <tr>
          <th className="py-1 font-normal">{t("charts.name")}</th>
          <th className="py-1 text-right font-normal">{t("charts.value")}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {data.map((d, i) => (
          <tr key={i}>
            <td className="py-1">{d.label}</td>
            <td className="py-1 text-right tabular-nums">{formatValue(d.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function niceMax(max: number): number {
  if (max <= 0) return 10;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const VB_W = 600;
const VB_H = 220;
const PAD = { top: 12, right: 12, bottom: 22, left: 8 };

/** A single-series trend over time. No legend (one series); the card title names it. */
export function LineChart({
  data,
  formatValue = (v) => String(v),
  height = 220,
}: {
  data: ChartPoint[];
  formatValue?: (v: number) => string;
  height?: number;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const allZero = data.length === 0 || data.every((d) => d.value === 0);
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const plotW = VB_W - PAD.left - PAD.right;
  const plotH = VB_H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.value)}`).join(" ");
  const areaPath = data.length > 0 ? `${linePath} L ${x(data.length - 1)} ${PAD.top + plotH} L ${x(0)} ${PAD.top + plotH} Z` : "";

  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || data.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * VB_W;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs(x(i) - px);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    setHover(nearest);
  }

  const gridFractions = [0, 0.25, 0.5, 0.75, 1];
  const labelIndexes = data.length > 0 ? [0, Math.floor((data.length - 1) / 2), data.length - 1] : [];

  return (
    <div>
      {data.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">{t("charts.noData")}</p>
      ) : (
        <div className="relative">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            className="w-full"
            style={{ height }}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            role="img"
            aria-label={t("charts.trend")}
          >
            {gridFractions.map((f) => (
              <line key={f} x1={PAD.left} x2={VB_W - PAD.right} y1={PAD.top + plotH * (1 - f)} y2={PAD.top + plotH * (1 - f)} stroke={GRID} strokeWidth={1} />
            ))}
            {!allZero && <path d={areaPath} fill={MARK} fillOpacity={0.1} stroke="none" />}
            <path d={linePath} fill="none" stroke={MARK} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {hover !== null && (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="#94a3b8" strokeWidth={1} />
                <circle cx={x(hover)} cy={y(data[hover].value)} r={4} fill={MARK} stroke="#fff" strokeWidth={2} />
              </>
            )}
            {labelIndexes.map((i, idx) => (
              <text
                key={idx}
                x={x(i)}
                y={VB_H - 6}
                fontSize={10}
                fill={AXIS_TEXT}
                textAnchor={idx === 0 ? "start" : idx === labelIndexes.length - 1 ? "end" : "middle"}
              >
                {data[i].label}
              </text>
            ))}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute -top-1 -translate-x-1/2 -translate-y-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm"
              style={{ left: `${(x(hover) / VB_W) * 100}%` }}
            >
              <div className="font-semibold text-slate-900">{formatValue(data[hover].value)}</div>
              <div className="text-slate-500">{data[hover].label}</div>
            </div>
          )}
        </div>
      )}
      <TableToggle show={showTable} onToggle={() => setShowTable((s) => !s)} />
      {showTable && <DataTable data={data} formatValue={formatValue} />}
    </div>
  );
}

/** A ranked horizontal bar list — the default form for "compare magnitude." The value
 * always sits outside the bar (never inside), so it's never at risk of being clipped. */
export function BarChart({ data, formatValue = (v) => String(v) }: { data: ChartPoint[]; formatValue?: (v: number) => string }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const max = Math.max(...data.map((d) => d.value), 0) || 1;

  return (
    <div>
      {data.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">{t("charts.noData")}</p>
      ) : (
        <div className="space-y-2">
          {data.map((d, i) => (
            <div
              key={i}
              className="relative flex items-center gap-2"
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover((h) => (h === i ? null : h))}
              onFocus={() => setHover(i)}
              onBlur={() => setHover((h) => (h === i ? null : h))}
              tabIndex={0}
            >
              <div className="w-28 shrink-0 truncate text-xs text-slate-600" title={d.label}>
                {d.label}
              </div>
              <div className="h-5 flex-1 overflow-hidden rounded-sm bg-slate-100">
                <div
                  className="h-5 bg-emerald-600"
                  style={{
                    width: `${d.value > 0 ? Math.max((d.value / max) * 100, 2) : 0}%`,
                    borderRadius: "0 4px 4px 0",
                    opacity: hover === null || hover === i ? 1 : 0.6,
                  }}
                />
              </div>
              <div className="w-20 shrink-0 text-right text-xs tabular-nums text-slate-700">{formatValue(d.value)}</div>
              {hover === i && (
                <div className="pointer-events-none absolute left-28 top-full z-10 mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm">
                  <div className="font-semibold text-slate-900">{formatValue(d.value)}</div>
                  <div className="text-slate-500">{d.label}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <TableToggle show={showTable} onToggle={() => setShowTable((s) => !s)} />
      {showTable && <DataTable data={data} formatValue={formatValue} />}
    </div>
  );
}
