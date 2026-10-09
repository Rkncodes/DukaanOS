import { BarcodeDetector, prepareZXingModule, type BarcodeFormat } from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { RETAIL_FORMATS, isAcceptable } from "./formats";

/**
 * Reads barcodes out of camera frames, entirely in the browser.
 *
 * The decoder is zxing (C++) compiled to WebAssembly, behind the standard BarcodeDetector API. Its
 * WebAssembly file is bundled with this app and loaded from this app's own origin (the library's default
 * is a public CDN). A frame is handed to the decoder in memory and never leaves the page: nothing is
 * uploaded, nothing is stored.
 *
 * This module is loaded only when the merchant starts the camera (see CameraScan).
 */

prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
});

const FORMATS: BarcodeFormat[] = [...RETAIL_FORMATS];

/** What one look at the camera found: no barcode, exactly one, or several different ones at once. */
export type Reading = { kind: "none" } | { kind: "one"; code: string } | { kind: "several"; codes: string[] };

export type Decoder = (video: HTMLVideoElement) => Promise<Reading>;

export function createDecoder(): Decoder {
  const detector = new BarcodeDetector({ formats: FORMATS });
  return async (video) => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return { kind: "none" };
    const found = (await detector.detect(video)).filter((barcode) => barcode.rawValue && isAcceptable(barcode.format, barcode.rawValue));
    const codes = [...new Set(found.map((barcode) => barcode.rawValue))];
    if (codes.length === 0) return { kind: "none" };
    return codes.length === 1 ? { kind: "one", code: codes[0] } : { kind: "several", codes };
  };
}
