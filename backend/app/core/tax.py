"""GST breakup, computed fresh from each line's tax-inclusive total -- never stored, the same
"computed, not stored" philosophy as a khata balance (app.modules.khata).

A product's price is its MRP: GST is already included, the Indian retail norm. So a line's tax
is *extracted* from its total rather than added on top, and the total a customer pays never
changes because of this module -- it only explains how much of that total was tax.

Only intra-state sales are modelled (CGST + SGST, split evenly): a single-location kirana store
selling to local customers. Inter-state IGST is out of scope.
"""

from decimal import ROUND_HALF_UP, Decimal

from pydantic import BaseModel

from app.core.types import MoneyOut

_CENTS = Decimal("0.01")


class TaxSummary(BaseModel):
    taxable_value: MoneyOut
    cgst: MoneyOut
    sgst: MoneyOut
    total_tax: MoneyOut


def _line_breakup(line_total: Decimal, rate: Decimal) -> tuple[Decimal, Decimal]:
    """(taxable_value, tax) for one line, extracted from its tax-inclusive total."""
    if rate <= 0:
        return line_total, Decimal("0.00")
    taxable = (line_total / (1 + rate / 100)).quantize(_CENTS, rounding=ROUND_HALF_UP)
    return taxable, line_total - taxable


def summarize(lines: list[tuple[Decimal, Decimal]]) -> TaxSummary:
    """`lines`: (line_total, tax_rate) pairs, e.g. from a cart's or order's items."""
    taxable_total = Decimal("0.00")
    tax_total = Decimal("0.00")
    for line_total, rate in lines:
        taxable, tax = _line_breakup(line_total, rate)
        taxable_total += taxable
        tax_total += tax
    half = (tax_total / 2).quantize(_CENTS, rounding=ROUND_HALF_UP)
    return TaxSummary(taxable_value=taxable_total, cgst=half, sgst=tax_total - half, total_tax=tax_total)
