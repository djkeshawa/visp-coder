"""Decimal rounding with shared validation for precision arguments."""
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP, ROUND_UP, localcontext
import math

from .values import Err

MODES = {"ROUND": ROUND_HALF_UP, "ROUNDUP": ROUND_UP, "ROUNDDOWN": ROUND_DOWN}


def round_number(function, number, digits):
    if not math.isfinite(digits) or not 0 <= digits <= 10 or digits != int(digits):
        return Err("#VALUE!")
    if not math.isfinite(number):
        return Err("#VALUE!")
    # Convert the decimal spelling, not the binary float expansion (e.g. 2.345).
    decimal = Decimal(str(number))
    with localcontext() as context:
        context.prec = max(28, decimal.adjusted() + int(digits) + 2)
        quantum = Decimal(1).scaleb(-int(digits))
        return float(decimal.quantize(quantum, rounding=MODES[function]))
