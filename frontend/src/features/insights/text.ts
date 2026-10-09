import type { AppLanguage, MessageKey } from "../../i18n";
import type { Schemas } from "../../lib/api/client";

type Insight = Schemas["InsightRead"];
type Say = (key: MessageKey, values?: Record<string, string | number>) => string;

/**
 * An insight's title and detail in the app's language. The backend writes them in English from a few fixed
 * sentences (backend/app/modules/insights/service.py); here each sentence is recognised and said again in the
 * chosen language, with the product or customer name, the numbers and the unit carried over exactly as sent.
 * In English, or for any sentence that is not recognised, the backend's own words are shown unchanged.
 */
export function insightText(insight: Insight, say: Say, language: AppLanguage): { title: string; detail: string } {
  if (language === "en") return { title: insight.title, detail: insight.detail };
  const title = TITLES[insight.kind];
  const detail = DETAILS[insight.kind];
  return { title: reword(insight.title, title, say), detail: reword(insight.detail, detail, say) };
}

type Sentence = { pattern: RegExp; key: MessageKey; values: (m: RegExpMatchArray, say: Say) => Record<string, string> };

function reword(text: string, sentences: Sentence[], say: Say): string {
  for (const { pattern, key, values } of sentences) {
    const m = text.match(pattern);
    if (m) return say(key, values(m, say));
  }
  return text;
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const TREND = { climbing: "insight.trend.climbing", slowing: "insight.trend.slowing", steady: "insight.trend.steady" } as const;

const TITLES: Record<Insight["kind"], Sentence[]> = {
  stockout_risk: [
    { pattern: new RegExp(`^(.+) may run out in ${NUMBER} days$`), key: "insight.stockout.title", values: (m) => ({ name: m[1], days: m[2] }) },
  ],
  dead_stock: [
    { pattern: new RegExp(`^(.+) hasn't sold in ${NUMBER}\\+ days$`), key: "insight.dead.title", values: (m) => ({ name: m[1], days: m[2] }) },
  ],
  customer_winback: [
    { pattern: new RegExp(`^(.+) hasn't come back in ${NUMBER} days$`), key: "insight.winback.title", values: (m) => ({ name: m[1], days: m[2] }) },
  ],
  khata_risk: [
    { pattern: /^(.+) owes (₹[\d,]+(?:\.\d+)?) with no recent payment$/, key: "insight.khata.title", values: (m) => ({ name: m[1], amount: m[2] }) },
  ],
};

const DETAILS: Record<Insight["kind"], Sentence[]> = {
  stockout_risk: [
    {
      pattern: new RegExp(`^${NUMBER} (.+?) sold in the last ${NUMBER} days \\((climbing|slowing|steady)\\), only ${NUMBER} (.+?) left$`),
      key: "insight.stockout.detail",
      values: (m, say) => ({ sold: m[1], unit: m[2], window: m[3], trend: say(TREND[m[4] as keyof typeof TREND]), left: m[5] }),
    },
  ],
  dead_stock: [
    { pattern: new RegExp(`^${NUMBER} (.+?) still on the shelf$`), key: "insight.dead.detail", values: (m) => ({ stock: m[1], unit: m[2] }) },
  ],
  customer_winback: [
    { pattern: new RegExp(`^Usually buys every ${NUMBER} days$`), key: "insight.winback.detail", values: (m) => ({ days: m[1] }) },
  ],
  khata_risk: [
    { pattern: /^Never paid back$/, key: "insight.khata.neverPaid", values: () => ({}) },
    { pattern: new RegExp(`^Last paid ${NUMBER} days ago$`), key: "insight.khata.lastPaid", values: (m) => ({ days: m[1] }) },
  ],
};
