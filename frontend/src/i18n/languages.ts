/**
 * The languages the app can be shown in. This is the *display* language only: what Voice Billing
 * listens for is chosen in Voice mode and stored separately (features/counter/voice/speech.ts).
 */
export const APP_LANGUAGES = [
  { code: "en", label: "English", htmlLang: "en" },
  { code: "hi", label: "हिंदी", htmlLang: "hi" },
  { code: "hinglish", label: "Hinglish", htmlLang: "hi-Latn" },
  { code: "ta", label: "தமிழ்", htmlLang: "ta" },
  { code: "bn", label: "বাংলা", htmlLang: "bn" },
  { code: "te", label: "తెలుగు", htmlLang: "te" },
  { code: "mr", label: "मराठी", htmlLang: "mr" },
  { code: "ml", label: "മലയാളം", htmlLang: "ml" },
  { code: "kn", label: "ಕನ್ನಡ", htmlLang: "kn" },
  { code: "gu", label: "ગુજરાતી", htmlLang: "gu" },
] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number]["code"];
export const DEFAULT_LANGUAGE: AppLanguage = "en";
export const APP_LANGUAGE_KEY = "dukaanos.app.language";

/** The language last chosen on this device (English until one is). */
export function loadAppLanguage(): AppLanguage {
  try {
    const saved = localStorage.getItem(APP_LANGUAGE_KEY);
    return APP_LANGUAGES.find((l) => l.code === saved)?.code ?? DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function saveAppLanguage(code: AppLanguage) {
  try {
    localStorage.setItem(APP_LANGUAGE_KEY, code);
  } catch {
    // Storage unavailable (private mode): the choice lasts for this visit.
  }
}
