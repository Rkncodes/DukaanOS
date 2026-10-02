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
    default:
      return "Speech recognition failed. Try again.";
  }
}
