Feature: Text case and length
Add text helpers to the spreadsheet engine.

1. `UPPER(value)` and `LOWER(value)` convert text case; `LEN(value)` returns its character count.
2. Each takes one argument; empty cells behave as empty text and errors propagate.
3. Preserve whitespace and count Unicode characters rather than bytes. Add tests and update the README.
---
Feature: CSV export
Add an `EXPORT A1:C5` command for sharing a rectangular region.

1. Write one CSV record per row in the selected rectangle, using evaluated values and standard CSV quoting.
2. Include empty fields and print error codes as text; exporting changes no cells.
3. Reject malformed ranges with ERROR. Add tests and update the README.
---
Feature: Cell comments
Add `NOTE <cell> <text>` to attach a comment to a cell.

1. Comments never participate in formula evaluation; setting a value preserves its comment.
2. `NOTE <cell>` removes the comment. Invalid cell names print ERROR without changes.
3. Add tests for replacement and removal and document the commands.
---
Feature: Named ranges
Add `NAME <name> <range>` to register a rectangular region.

1. Names contain letters and underscores, are case-insensitive, and cannot collide with cell references or function names.
2. A named range can be used wherever a function accepts a range; changing its definition updates dependent values.
3. Invalid names or ranges print ERROR without replacing an existing definition. Add tests and documentation.
---
Feature: Clear the sheet
Add the `CLEARALL` command for starting a new calculation.

1. Clear every cell and stored formula without printing a result.
2. A subsequent GET of a cleared cell prints an empty line; a new formula sees cleared references as empty.
3. Extra arguments print ERROR and leave the sheet unchanged. Add tests and update the README.
---
Feature: Absolute values and signs
Add `ABS(number)` and `SIGN(number)` to formulas.

1. ABS returns the magnitude; SIGN returns -1, 0, or 1 according to the sign.
2. Each takes one argument, treats an empty cell as zero, rejects text with #VALUE!, and propagates errors.
3. Add tests for negative values, zero, and referenced cells, and update the contract.
---
Feature: Round to a step
Add `ROUNDTO(number, step)` for rounding quantities to packaging increments.

1. Return the nearest multiple of step, breaking ties away from zero.
2. For ROUNDTO, step must be a positive number no larger than 1000; otherwise #VALUE!.
3. Accept fractional steps such as 0.25, propagate operand errors, and require exactly two arguments. Add tests and update the README.
---
Feature: Percentile summaries
Add `PERCENTILE(range, fraction)` for summarizing numeric observations.

1. Ignore empty and text cells in the range; propagate errors in row order.
2. For PERCENTILE, over no numbers the result is 0. With numbers, sort them and linearly interpolate at index fraction times one less than the count.
3. Require a numeric fraction between zero and one inclusive; otherwise return #VALUE!. Add tests and document the feature.
