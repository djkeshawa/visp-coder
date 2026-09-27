This repository already contains a working spreadsheet engine; its contract is in README.md. Add these two functions:

1. `AVERAGE(...)` takes arguments and ranges exactly like SUM: ignore empty and text cells inside ranges, return `#VALUE!` for a text value passed directly, and propagate errors as SUM does. Return the sum of the numbers divided by their count. House rule for this engine, now and for every statistic function we add later: a statistic over no numbers is `#DIV/0!`, never 0. AVERAGE over no numbers is therefore `#DIV/0!`.
2. `ROUND(number, digits)` takes exactly two arguments and rounds half away from zero: `ROUND(-2.5, 0)` is -3 and `ROUND(2.345, 2)` is 2.35. For this feature, `digits` must be a whole number from 0 to 10; anything else (a negative number, a fraction, more than 10, text) is `#VALUE!`.
3. Keep all existing behavior and tests passing, add tests for the new behavior, and update the README contract.

Use only the Python standard library. Run with ./run.sh as before.
