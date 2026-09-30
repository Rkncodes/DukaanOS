"""Shared Pydantic field types.

Money and quantities are Decimals serialized as fixed-scale strings in JSON
("14.00", "2.000") so clients never see float rounding.
"""

from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel as _BaseModel
from pydantic import ConfigDict, Field, PlainSerializer

_CENTS = Decimal("0.01")
_MILLI = Decimal("0.001")

# Request fields
Money = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2)]
PositiveMoney = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]
Quantity = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=3)]

# Response fields
MoneyOut = Annotated[Decimal, PlainSerializer(lambda v: str(v.quantize(_CENTS)), return_type=str)]
QuantityOut = Annotated[Decimal, PlainSerializer(lambda v: str(v.quantize(_MILLI)), return_type=str)]


class Schema(_BaseModel):
    model_config = ConfigDict(from_attributes=True)
