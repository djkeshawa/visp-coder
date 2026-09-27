Next change to the spreadsheet engine in this repository.

1. `MEDIAN(...)` takes arguments and ranges like SUM. Return the middle number of the sorted numbers, or the mean of the two middle ones for an even count.
2. `ROUNDUP(number, digits)` and `ROUNDDOWN(number, digits)` each take exactly two arguments. Round away from zero and toward zero, respectively, to `digits` decimal places.
3. Keep all existing behavior and tests passing, add tests for the new behavior, and update the README contract.

Use only the Python standard library. Run with ./run.sh as before.
