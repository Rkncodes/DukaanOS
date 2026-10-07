import { MAX_QUANTITY } from "./cart";

type Props = {
  name: string;
  quantity: number;
  onChange: (quantity: number) => void;
  disabled?: boolean;
};

/** [ + ] to add; once in the cart, − quantity +. Going below 1 removes the product. */
export function QuantityStepper({ name, quantity, onChange, disabled }: Props) {
  const button =
    "h-8 w-8 rounded-md border border-emerald-600 text-lg leading-none text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-300";
  if (quantity === 0)
    return (
      <button type="button" aria-label={`Add ${name}`} disabled={disabled} onClick={() => onChange(1)} className={button}>
        +
      </button>
    );
  return (
    <div className="flex items-center gap-2">
      <button type="button" aria-label={`Decrease ${name}`} onClick={() => onChange(quantity - 1)} className={button}>
        −
      </button>
      <span aria-label={`Quantity of ${name}`} className="w-6 text-center text-sm font-medium">
        {quantity}
      </span>
      <button
        type="button"
        aria-label={`Increase ${name}`}
        disabled={disabled || quantity >= MAX_QUANTITY}
        onClick={() => onChange(quantity + 1)}
        className={button}
      >
        +
      </button>
    </div>
  );
}
