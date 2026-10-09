/**
 * The browser's own speech recognition (Web Speech API). No key and no backend service: the
 * browser records and transcribes, and only the transcript is sent to DukaanOS.
 * Not every browser has it (Chrome, Edge and Safari do; Firefox does not), so callers must
 * handle `speechRecognition()` returning null.
 *
 * The language spoken here is the merchant's choice for Voice Billing only; it is separate from the
 * app's display language (../../../i18n), and neither changes the other.
 */

import { translate } from "../../../i18n";

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };

/** The part of SpeechRecognition used here. */
export type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

/** English as spoken in India; product names are matched to the catalogue afterwards. */
export const SPEECH_LANGUAGE = "en-IN";

/**
 * The languages a shopkeeper can speak in. `lang` is what the browser's recogniser is asked for.
 * It has no Hinglish and no auto-detect: Hindi mixed with English is recognised by its Hindi
 * recogniser, which writes Hindi words in Devanagari. The backend reads every language here alike.
 * Whether a browser can recognise a given one is the browser's affair: if it cannot, it says so
 * ("language-not-supported") and the merchant is told; the language is never switched for them.
 */
export const SPEECH_LANGUAGES = [
  { id: "en", label: "English", lang: SPEECH_LANGUAGE },
  { id: "hi", label: "हिंदी", lang: "hi-IN" },
  { id: "hinglish", label: "Hinglish", lang: "hi-IN" },
  { id: "ta", label: "தமிழ்", lang: "ta-IN" },
  { id: "bn", label: "বাংলা", lang: "bn-IN" },
  { id: "te", label: "తెలుగు", lang: "te-IN" },
  { id: "mr", label: "मराठी", lang: "mr-IN" },
  { id: "ml", label: "മലയാളം", lang: "ml-IN" },
  { id: "kn", label: "ಕನ್ನಡ", lang: "kn-IN" },
  { id: "gu", label: "ગુજરાતી", lang: "gu-IN" },
] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number]["id"];

const LANGUAGE_KEY = "dukaanos.voice.language";

/** The language last chosen on this device (English until one is). */
export function loadSpeechLanguage(): SpeechLanguage {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    return SPEECH_LANGUAGES.find((l) => l.id === saved)?.id ?? "en";
  } catch {
    return "en";
  }
}

export function saveSpeechLanguage(id: SpeechLanguage) {
  try {
    localStorage.setItem(LANGUAGE_KEY, id);
  } catch {
    // Storage unavailable: the choice just lasts for this visit.
  }
}

export function speechRecognition(): (new () => Recognizer) | null {
  const w = window as unknown as Record<string, (new () => Recognizer) | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** SpeechRecognitionErrorEvent.error -> what the merchant can do about it, in the app's language. */
export function speechErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return translate("voice.error.blocked");
    case "audio-capture":
      return translate("voice.error.noMicrophone");
    case "no-speech":
      return translate("voice.error.noSpeech");
    case "network":
      return translate("voice.error.network");
    case "language-not-supported":
      return translate("voice.error.language");
    default:
      return translate("voice.error.failed");
  }
}
