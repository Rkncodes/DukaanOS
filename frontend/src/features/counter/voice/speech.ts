/**
 * The browser's own speech recognition (Web Speech API). No key and no backend service: the
 * browser records and transcribes, and only the transcript is sent to DukaanOS.
 * Not every browser has it (Chrome, Edge and Safari do; Firefox does not), so callers must
 * handle `speechRecognition()` returning null.
 */

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

/** SpeechRecognitionErrorEvent.error -> what the merchant can do about it. */
export function speechErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked. Allow the microphone for this site in the browser, then try again.";
    case "audio-capture":
      return "No microphone was found. Connect one, then try again.";
    case "no-speech":
      return "Nothing was heard. Try again and speak your items.";
    case "network":
      return "Speech recognition could not reach the browser's speech service. Check the internet connection, then try again.";
    case "language-not-supported":
      return "This browser cannot recognise speech in the chosen language. Choose another language, or type the items instead.";
    default:
      return "Speech recognition failed. Try again.";
  }
}
