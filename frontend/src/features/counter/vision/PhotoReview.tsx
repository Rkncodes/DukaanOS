import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Schemas } from "../../../lib/api/client";
import { recognizePhoto } from "./api";
import { DetectionOverlay, MockNotice } from "./DetectionOverlay";
import { DetectionReview } from "./DetectionReview";
import { ACCEPTED_IMAGE_TYPES, imageFileError, initialRows, type Product, type ReviewRow } from "./review";

type Props = {
  products: Product[];
  /** Adds the confirmed items to the existing Counter cart. */
  onConfirm: (items: Schemas["ConfirmedItem"][]) => Promise<unknown>;
  onClose: () => void;
};

/**
 * Photo -> detections -> merchant confirmation. Nothing reaches the cart until "Add to bill".
 * Unmatched or undecided detections are never added.
 */
export function PhotoReview({ products, onConfirm, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  const recognize = useMutation({
    mutationFn: recognizePhoto,
    onSuccess: (result) => setRows(initialRows(result.detections)),
  });

  function choose(selected: File | undefined) {
    if (!selected) return;
    recognize.reset();
    setRows([]);
    const error = imageFileError(selected);
    setFileError(error);
    setFile(error ? null : selected);
    if (!error) recognize.mutate(selected);
  }

  const result = recognize.data;

  return (
    <section aria-label="Add from photo" className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium text-slate-900">Add from photo</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">
          Cancel
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        aria-label="Photo of products"
        className="hidden"
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = ""; // allow re-choosing the same file
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={recognize.isPending}
        className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
      >
        {file ? "Choose another photo" : "Choose photo"}
      </button>
      {fileError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {fileError}
        </p>
      )}

      {previewUrl && (
        <div className="relative mt-3 w-full max-w-sm overflow-hidden rounded border border-slate-200">
          <img src={previewUrl} alt="Uploaded products" className="block w-full" />
          <DetectionOverlay detections={rows.map((r) => r.detection)} />
        </div>
      )}

      {recognize.isPending && (
        <p role="status" className="mt-3 text-sm text-slate-600">
          Recognizing products…
        </p>
      )}
      {recognize.error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {recognize.error.message}
        </p>
      )}

      {result && (
        <div className="mt-4">
          {result.is_mock && (
            <div className="mb-3">
              <MockNotice>
                Demo recognizer (<code>{result.provider}</code>): these detections are fixed sample data for every
                photo, not real AI.
              </MockNotice>
            </div>
          )}
          <DetectionReview
            rows={rows}
            setRows={setRows}
            products={products}
            emptyText={result.detections.length === 0 ? "No products detected in this photo." : "All detections removed."}
            onConfirm={onConfirm}
            onConfirmed={onClose}
          />
        </div>
      )}
    </section>
  );
}
