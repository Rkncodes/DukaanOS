import { useCallback, useSyncExternalStore } from "react";
import { APP_LANGUAGES, loadAppLanguage, saveAppLanguage, type AppLanguage } from "./languages";
import { bn } from "./locales/bn";
import { en, type MessageKey, type Messages } from "./locales/en";
import { gu } from "./locales/gu";
import { hi } from "./locales/hi";
import { hinglish } from "./locales/hinglish";
import { kn } from "./locales/kn";
import { ml } from "./locales/ml";
import { mr } from "./locales/mr";
import { ta } from "./locales/ta";
import { te } from "./locales/te";

/**
 * The app's display language. One small store: the current language, the ten dictionaries, and
 * `t(key)`. There is no library behind it (lookup, `{{value}}` substitution and an English
 * fallback are all the app needs), so it adds no dependency and nothing is fetched at run time.
 *
 * All translated text lives in ./locales. Components call `useTranslation()`; code outside
 * React (pure helpers that produce a message) calls `translate()`.
 */
export const MESSAGES: Record<AppLanguage, Messages> = { en, hi, hinglish, ta, bn, te, mr, ml, kn, gu };

export type { MessageKey } from "./locales/en";
export { APP_LANGUAGES, type AppLanguage } from "./languages";

type Values = Record<string, string | number>;

let current: AppLanguage = loadAppLanguage();
const listeners = new Set<() => void>();
/** Keys asked for that a dictionary did not have: for tests and for whoever is watching the console. */
export const missingKeys = new Set<string>();

function applyToDocument() {
  if (typeof document !== "undefined") document.documentElement.lang = APP_LANGUAGES.find((l) => l.code === current)!.htmlLang;
}
applyToDocument(); // before the first render: the page never starts in the wrong language

export function getAppLanguage(): AppLanguage {
  return current;
}

/** Switch the whole app, at once, and remember it on this device. */
export function setAppLanguage(language: AppLanguage) {
  if (language === current) return;
  current = language;
  saveAppLanguage(language);
  applyToDocument();
  for (const listener of listeners) listener();
}

/** Re-read the saved choice (what a page reload does). */
export function reloadAppLanguage() {
  current = loadAppLanguage();
  applyToDocument();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function reportMissing(key: string, language: AppLanguage) {
  const id = `${language}:${key}`;
  if (missingKeys.has(id)) return;
  missingKeys.add(id);
  if (import.meta.env.DEV) console.warn(`[i18n] no "${key}" in ${language}`);
}

/** "cart.totalDue" -> "Total due": something readable when a key is in no dictionary at all. */
function readable(key: string): string {
  const words = (key.split(".").pop() ?? key).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The text for `key` in `language`. A key the language lacks falls back to English; a key
 * English lacks too is shown as readable words rather than as the key itself. Either is
 * recorded in `missingKeys` and warned about in development.
 */
export function translateIn(language: AppLanguage, key: string, values?: Values): string {
  let text = (MESSAGES[language] as Record<string, string | undefined>)[key];
  if (text === undefined) {
    reportMissing(key, language);
    text = (en as Record<string, string | undefined>)[key] ?? readable(key);
  }
  return values ? text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole)) : text;
}

/** For code outside React. Inside a component use `useTranslation()`, which re-renders on a change. */
export function translate(key: MessageKey, values?: Values): string {
  return translateIn(current, key, values);
}

/**
 * The display label of a stored value (an enum the backend sends, such as a bill line's source).
 * The value itself is never changed; a value with no label is shown as it is.
 */
export function labelFor(group: string, value: string): string {
  const key = `${group}.${value}`;
  return key in en ? translateIn(current, key) : value;
}

/**
 * What to show for a failed request. The backend's messages are English: in English they are shown
 * as they are (they are the most specific); in any other language the error's `code` picks a
 * translated line. A code with no translation, or an error with no code, keeps the original message
 * rather than showing nothing. The error itself is never changed.
 */
export function problemIn(language: AppLanguage, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (language === "en") return message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && `error.${code}` in en) return translateIn(language, `error.${code}`);
  // The browser's own "Failed to fetch": the request never reached the backend.
  if (error instanceof TypeError && /fetch|network|load failed/i.test(message)) return translateIn(language, "error.network");
  return message;
}

/** The locale for dates in `language`, with the same digits as the prices beside them. */
export function dateLocaleOf(language: AppLanguage): string {
  return language === "en" || language === "hinglish" ? "en-IN" : `${language}-IN-u-nu-latn`;
}

export function useTranslation() {
  const language = useSyncExternalStore(subscribe, getAppLanguage, getAppLanguage);
  const t = useCallback((key: MessageKey, values?: Values) => translateIn(language, key, values), [language]);
  const problem = useCallback((error: unknown) => problemIn(language, error), [language]);
  const label = useCallback((group: string, value: string) => {
    const key = `${group}.${value}`;
    return key in en ? translateIn(language, key) : value;
  }, [language]);
  return { t, label, problem, language, dateLocale: dateLocaleOf(language) };
}
