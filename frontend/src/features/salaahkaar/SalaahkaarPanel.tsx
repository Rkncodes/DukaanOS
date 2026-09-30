export function SalaahkaarPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-10 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-sm flex-col border-l border-slate-200 bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="font-semibold">Salaahkaar</h2>
          <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">
            Close
          </button>
        </div>
        <div className="flex-1 p-4 text-sm text-slate-500">
          Your AI merchant assistant arrives in the Salaahkaar phase. It will answer questions from your real shop data
          and propose actions (add to bill, record payment) that you confirm.
        </div>
        <div className="border-t border-slate-200 p-3">
          <input
            disabled
            placeholder="Ask anything (coming soon)"
            className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
          />
        </div>
      </aside>
    </div>
  );
}
