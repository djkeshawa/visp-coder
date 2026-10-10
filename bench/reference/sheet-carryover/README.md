# Spreadsheet engine

Run: `./run.sh` (Python 3.10, standard library only). Tests: `python3 -m unittest discover -s tests`.

Layout: `sheet/parser.py` tokenizes and parses formulas into tuple nodes, `sheet/engine.py` stores cells, finds cycles and evaluates, `sheet/values.py` holds value types and output formatting, `sheet/cells.py` cell names and ranges, `sheet/rounding.py` decimal rounding, `sheet/cli.py` the commands.

## Contract

- Start command: `./run.sh` reads commands from standard input, one per line, and writes one output line for every `GET` and for every invalid command. Use only the standard library of Python 3.10 or Node.js 22; no dependency downloads.
- Cells are named by one letter `A`–`Z` followed by a row `1`–`99` (for example `A1`, `Z99`); letters are case-insensitive on input.
- Commands (keywords are case-insensitive, separated by single spaces):
  - `SET <cell> <content>`: everything after the second space is the cell's raw content. Content starting with `=` is a formula. Content that is a number (an optional `+` or `-`, one or more digits, then optionally `.` and one or more digits, for example `-3` or `2.50`; `.5` and `1e3` are not numbers) is a number. Any other content is text. Empty content clears the cell.
  - `GET <cell>`: prints the cell's current value.
  - `CLEAR <cell>`: empties the cell.
  - Any other line, a `SET`/`GET`/`CLEAR` with a missing or invalid cell name, prints `ERROR` and changes nothing. Blank lines are ignored.
- Values printed by `GET`:
  - An empty cell prints an empty line.
  - Numbers print without a trailing `.0`: integers as integers; other numbers rounded to at most 6 decimal places with trailing zeros removed (`1/3` prints `0.333333`, `2/4` prints `0.5`). Negative zero prints `0`.
  - Text prints as stored.
  - Errors print as their code: `#DIV/0!`, `#VALUE!`, `#REF!`, `#CYCLE!`, `#PARSE!`.
- Formulas:
  - Numbers (digits with an optional `.` and digits), cell references, parentheses, binary `+ - * / ^` and unary `-` and `+`.
  - Precedence from highest: unary sign, then `^` (right-associative), then `*` and `/`, then `+` and `-` (left-associative). So `=-2^2` is `4` and `=2^3^2` is `512`.
  - Functions `SUM`, `MIN`, `MAX` (case-insensitive) take one or more arguments separated by commas; each argument is an expression or a range `A1:B3` (any two corners, inclusive). They ignore empty and text cells inside ranges; a text value passed directly as an argument is `#VALUE!`. `MIN` and `MAX` over no numbers are `0`.
  - `AVERAGE` and `MEDIAN` take one or more arguments and ranges exactly like SUM, including ignoring empty/text cells inside ranges, rejecting directly passed text with `#VALUE!`, and propagating errors in the same order. AVERAGE returns the sum divided by the count. MEDIAN sorts the numbers and returns the middle number, or the mean of the two middle numbers for an even count.
  - House rule for new statistic functions: over no numbers the result is `#DIV/0!`, never 0. This applies to AVERAGE and MEDIAN; existing SUM/MIN/MAX behavior is unchanged. A directly passed empty cell still counts as the number zero.
  - `ROUND(number, digits)`, `ROUNDUP(number, digits)`, and `ROUNDDOWN(number, digits)` take exactly two scalar arguments; a wrong argument count is `#PARSE!`. ROUND rounds half away from zero (`ROUND(-2.5,0)` is -3, `ROUND(2.345,2)` is 2.35); ROUNDUP rounds away from zero and ROUNDDOWN toward zero. Decimal quantization avoids binary float expansion artifacts at rounding ties.
  - A digits argument must be a whole number from 0 to 10 inclusive for all three rounding functions; negative, fractional, oversized, or text digits return `#VALUE!`. Empty scalar references count as zero. Text numbers and range arguments return `#VALUE!`; operand errors propagate left to right. GET retains its existing six-decimal display limit even when more decimal places are requested.
  - An empty cell counts as `0`. A formula that is just a reference (`=A1`) takes the referenced value, including text; text used with any operator or sign is `#VALUE!`.
  - Spaces are allowed between tokens.
- Errors:
  - Division by zero is `#DIV/0!`.
  - A reference to a cell outside `A1`–`Z99` (for example `AA1` or `A100`) is `#REF!`.
  - A formula that cannot be parsed, or uses an unknown function, is `#PARSE!`.
  - Every cell whose formula is part of a reference cycle is `#CYCLE!`. A cell that depends on an error cell takes that error; if several operands are errors, the first one in left-to-right order in the formula wins, and inside a range the first in row order (row by row, left to right within a row).
- Values always reflect the current contents of all cells: changing a cell updates every cell that depends on it, and removing a cycle removes the `#CYCLE!` results.
