"""Hidden tests for the spreadsheet extension: the existing contract as regression plus new behavior. Usage: hidden_test.py <project_dir>"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
RESULTS = []

# (name, commands, expected output lines). Expected values were computed by hand from the
# contract and cross-checked against a reference implementation.
CASES = [
    ("number and text", ["SET A1 5", "SET A2 hello world", "GET A1", "GET A2", "GET A3"], ["5", "hello world", ""]),
    ("decimals print", ["SET A1 2.50", "SET A2 =1/3", "SET A3 =2/4", "GET A1", "GET A2", "GET A3"], ["2.5", "0.333333", "0.5"]),
    ("not numbers are text", ["SET A1 .5", "SET A2 1e3", "SET A3 =A1+1", "GET A1", "GET A2", "GET A3"], [".5", "1e3", "#VALUE!"]),
    ("signed numbers", ["SET A1 -3", "SET A2 +4", "SET A3 =A1+A2", "GET A3"], ["1"]),
    ("precedence", ["SET A1 =2+3*4", "SET A2 =(2+3)*4", "SET A3 =10-4-3", "SET A4 =12/3/2", "GET A1", "GET A2", "GET A3", "GET A4"], ["14", "20", "3", "2"]),
    ("power right assoc", ["SET A1 =2^3^2", "SET A2 =(2^3)^2", "GET A1", "GET A2"], ["512", "64"]),
    ("unary binds tighter than power", ["SET A1 =-2^2", "SET A2 =-(2^2)", "SET A3 =2*-3", "SET A4 =--3", "GET A1", "GET A2", "GET A3", "GET A4"], ["4", "-4", "-6", "3"]),
    ("spaces between tokens", ["SET A1 = 1 +  2 * ( 3 )", "GET A1"], ["7"]),
    ("empty counts as zero", ["SET A1 =B1+1", "SET A2 =B1", "GET A1", "GET A2"], ["1", "0"]),
    ("reference to text", ["SET B1 hi", "SET A1 =B1", "SET A2 =-B1", "SET A3 =B1*1", "GET A1", "GET A2", "GET A3"], ["hi", "#VALUE!", "#VALUE!"]),
    ("case insensitive", ["set a1 4", "Set B1 =a1*2", "get b1", "GET A1"], ["8", "4"]),
    ("division by zero", ["SET A1 =1/0", "SET A2 =1/(2-2)", "SET A3 =A1+1", "GET A1", "GET A2", "GET A3"], ["#DIV/0!", "#DIV/0!", "#DIV/0!"]),
    ("bad reference", ["SET A1 =AA1+1", "SET A2 =A100", "SET A3 =A0*2", "GET A1", "GET A2", "GET A3"], ["#REF!", "#REF!", "#REF!"]),
    ("parse errors", ["SET A1 =1+", "SET A2 =(1", "SET A3 =FOO(1)", "SET A4 =1 2", "SET A5 =", "GET A1", "GET A2", "GET A3", "GET A4", "GET A5"], ["#PARSE!", "#PARSE!", "#PARSE!", "#PARSE!", "#PARSE!"]),
    ("sum range", ["SET A1 1", "SET A2 2", "SET B1 3", "SET B2 x", "SET C1 =SUM(A1:B2)", "SET C2 =SUM(B2:A1)", "GET C1", "GET C2"], ["6", "6"]),
    ("sum arguments", ["SET A1 1", "SET C1 =SUM(A1, 2, 3*4)", "SET C2 =sum(A1:A3,10)", "GET C1", "GET C2"], ["15", "11"]),
    ("min max", ["SET A1 5", "SET A2 -2", "SET A3 text", "SET C1 =MIN(A1:A3)", "SET C2 =MAX(A1:A3)", "SET C3 =MIN(D1:D5)", "SET C4 =MAX(A1:A3, 9)", "GET C1", "GET C2", "GET C3", "GET C4"], ["-2", "5", "0", "9"]),
    ("text argument to function", ["SET A1 word", "SET C1 =SUM(A1)", "SET C2 =SUM(A1:A1)", "GET C1", "GET C2"], ["#VALUE!", "0"]),
    ("error in range propagates", ["SET A1 =1/0", "SET B1 =AA1", "SET C1 =SUM(A1:B1)", "SET C2 =SUM(B1:A1)", "GET C1", "GET C2"], ["#DIV/0!", "#DIV/0!"]),
    ("range row order", ["SET B1 =1/0", "SET A2 =AA1", "SET C1 =SUM(A1:B2)", "GET C1"], ["#DIV/0!"]),
    ("first error left to right", ["SET A1 =1/0", "SET A2 =AA1", "SET C1 =A2+A1", "SET C2 =A1+A2", "GET C1", "GET C2"], ["#REF!", "#DIV/0!"]),
    ("range with bad corner", ["SET C1 =SUM(A1:AA2)", "GET C1"], ["#REF!"]),
    ("function nesting", ["SET A1 2", "SET C1 =MAX(SUM(A1,1), MIN(4,5))*2", "GET C1"], ["8"]),
    ("recalculation", ["SET A1 1", "SET A2 =A1*10", "SET A3 =A2+A1", "GET A3", "SET A1 2", "GET A3", "CLEAR A1", "GET A3"], ["11", "22", "0"]),
    ("self cycle", ["SET A1 =A1+1", "GET A1"], ["#CYCLE!"]),
    ("cycle members and dependents", ["SET A1 =B1", "SET B1 =C1+1", "SET C1 =A1", "SET D1 =A1*2", "SET E1 5", "GET A1", "GET B1", "GET C1", "GET D1", "GET E1"], ["#CYCLE!", "#CYCLE!", "#CYCLE!", "#CYCLE!", "5"]),
    ("cycle through range", ["SET A1 =SUM(A1:A3)", "SET A2 =SUM(B1:B2)", "GET A1", "GET A2"], ["#CYCLE!", "0"]),
    ("breaking a cycle", ["SET A1 =B1+1", "SET B1 =A1+1", "GET A1", "SET B1 3", "GET A1", "GET B1"], ["#CYCLE!", "4", "3"]),
    ("cycle overrides other errors", ["SET A1 =1/0+B1", "SET B1 =A1", "GET A1"], ["#CYCLE!"]),
    ("set empty clears", ["SET A1 7", "SET A1 ", "GET A1", "SET B1 =A1+1", "GET B1"], ["", "1"]),
    ("invalid commands", ["HELLO", "GET", "GET AA1", "SET A100 5", "CLEAR", "GET A1 extra", "SET A1 1", "GET A1"], ["ERROR", "ERROR", "ERROR", "ERROR", "ERROR", "ERROR", "1"]),
    ("blank lines ignored", ["", "SET A1 3", "   ", "GET A1"], ["3"]),
    ("negative zero", ["SET A1 =-0", "SET A2 =0*-1", "GET A1", "GET A2"], ["0", "0"]),
    ("rounding", ["SET A1 =2/3", "SET A2 =1/8", "SET A3 =10/4", "GET A1", "GET A2", "GET A3"], ["0.666667", "0.125", "2.5"]),
    ("long chain", [f"SET A{r} =A{r - 1}+1" for r in range(2, 100)] + ["SET A1 1", "GET A99", "SET A1 100", "GET A99"], ["99", "198"]),
    ("grid sum", [f"SET {c}{r} 1" for c in "ABCDEFGHIJ" for r in range(1, 21)] + ["SET Z99 =SUM(A1:J20)", "GET Z99", "SET Z98 =SUM(J20:A1)*2", "GET Z98"], ["200", "400"]),
    ("clear referenced", ["SET A1 4", "SET B1 =A1^2", "CLEAR A1", "GET B1"], ["0"]),
    # The extension: the existing case above becomes a text literal.
    ("new: text literal", ["SET A1 =\"x\"", "SET A2 =\"say \"\"hi\"\"\"", "SET A3 =\"\"", "GET A1", "GET A2", "GET A3"], ["x", 'say "hi"', ""]),
    ("new: concatenation operands", ["SET B1 5", "SET B2 text", "SET A1 =B1&\"-\"&B2&C1&1/4", "GET A1"], ["5-text0.25"]),
    ("new: concatenation precedence", ["SET A1 =1+2&3*4", "SET A2 =\"a\"&-2^2", "GET A1", "GET A2"], ["312", "a4"]),
    ("new: concatenation error", ["SET B1 =1/0", "SET A1 =\"a\"&B1&AA1", "SET A2 =AA1&B1", "GET A1", "GET A2"], ["#DIV/0!", "#REF!"]),
    ("new: number comparisons", ["SET A1 =1<2", "SET A2 =2<=2", "SET A3 =3>4", "SET A4 =2<>2", "SET A5 =1+1=2", "GET A1", "GET A2", "GET A3", "GET A4", "GET A5"], ["TRUE", "TRUE", "FALSE", "FALSE", "TRUE"]),
    ("new: text comparisons", ["SET B1 apple", "SET A1 =B1=\"apple\"", "SET A2 =B1=\"Apple\"", "SET A3 =\"B\"<\"a\"", "SET A4 =C1=\"\"", "SET A5 =C1=0", "GET A1", "GET A2", "GET A3", "GET A4", "GET A5"], ["TRUE", "FALSE", "TRUE", "TRUE", "TRUE"]),
    ("new: mixed comparison", ["SET B1 text", "SET A1 =B1<1", "SET A2 =\"1\"=1", "GET A1", "GET A2"], ["#VALUE!", "#VALUE!"]),
    ("new: comparisons not chained", ["SET A1 =1<2<3", "GET A1"], ["#PARSE!"]),
    ("new: comparison lowest precedence", ["SET A1 =\"a\"&\"b\"=\"ab\"", "GET A1"], ["TRUE"]),
    ("new: boolean in arithmetic", ["SET B1 =1<2", "SET A1 =B1+1", "SET A2 =-B1", "SET A3 =SUM(B1)", "SET A4 =B1&\"!\"", "GET A1", "GET A2", "GET A3", "GET A4"], ["#VALUE!", "#VALUE!", "#VALUE!", "TRUE!"]),
    ("new: booleans ignored in ranges", ["SET B1 =1<2", "SET B2 4", "SET A1 =SUM(B1:B2)", "SET A2 =MAX(B1:B2)", "GET A1", "GET A2"], ["4", "4"]),
    ("new: if chooses", ["SET B1 5", "SET A1 =IF(B1>3, \"big\", \"small\")", "SET A2 =IF(0, 1, 2)", "SET A3 =IF(C1, 1, 2)", "SET A4 =IF(-1, 1, 2)", "GET A1", "GET A2", "GET A3", "GET A4"], ["big", "2", "2", "1"]),
    ("new: if evaluates one branch", ["SET A1 =IF(1<2, 7, 1/0)", "SET A2 =IF(1>2, AA1, 3)", "GET A1", "GET A2"], ["7", "3"]),
    ("new: if condition errors", ["SET B1 word", "SET A1 =IF(B1, 1, 2)", "SET A2 =IF(1/0, 1, 2)", "GET A1", "GET A2"], ["#VALUE!", "#DIV/0!"]),
    ("new: if argument count", ["SET A1 =IF(1, 2)", "SET A2 =IF(1, 2, 3, 4)", "GET A1", "GET A2"], ["#PARSE!", "#PARSE!"]),
    ("new: cycle through untaken branch", ["SET A1 =IF(1, 5, A1)", "GET A1"], ["#CYCLE!"]),
    ("new: count", ["SET A1 1", "SET A2 x", "SET A3 =1<2", "SET A4 =1/0", "SET A5 2.5", "SET B1 =COUNT(A1:A6)", "SET B2 =COUNT(1, \"x\", A1)", "SET B3 =COUNT(A4)", "GET B1", "GET B2", "GET B3"], ["2", "2", "#DIV/0!"]),
    ("new: absolute references read", ["SET A1 3", "SET B1 =$A$1+A$1+$A1", "SET B2 =SUM($A$1:A$1)", "GET B1", "GET B2"], ["9", "3"]),
    ("new: copy moves relative parts", ["SET A1 1", "SET A2 2", "SET B1 =A1*10", "COPY B1 B2", "GET B2", "FORMULA B2"], ["20", "=A2*10"]),
    ("new: copy keeps absolute parts", ["SET C1 =A1+$A$1+A$1+$A1+SUM(A1:$B$2)", "COPY C1 E4", "FORMULA E4"], ["=C4+$A$1+C$1+$A4+SUM(C4:$B$2)"]),
    ("new: copy out of range", ["SET B2 =A1+C3", "COPY B2 A1", "FORMULA A1", "GET A1", "COPY B2 Z99", "FORMULA Z99"], ["=#REF!+B2", "#CYCLE!", "=Y98+#REF!"]),
    ("new: copy upper-cases references only", ["SET A1 =sum(a1:b2)+\"b1\"", "COPY A1 A2", "FORMULA A2"], ["=sum(A2:B3)+\"b1\""]),
    ("new: copy values and empty", ["SET A1 hello", "SET B1 2.50", "COPY A1 A5", "COPY B1 B5", "SET C5 9", "COPY C9 C5", "GET A5", "FORMULA B5", "GET C5"], ["hello", "2.50", ""]),
    ("new: formula command", ["SET A1 =1 + 2", "SET A2 text", "FORMULA A1", "FORMULA A2", "FORMULA A3", "FORMULA AA1"], ["=1 + 2", "text", "", "ERROR"]),
    ("new: copy invalid names", ["COPY A1", "COPY A1 AA1", "COPY Q A2"], ["ERROR", "ERROR", "ERROR"]),
    ("new: copied formula recalculates", ["SET A1 1", "SET A2 2", "SET B1 =A1+1", "COPY B1 B2", "SET A2 10", "GET B2"], ["11"]),
]


def run(commands):
    completed = subprocess.run(
        ["./run.sh"], cwd=ROOT, input="\n".join(commands) + "\n", capture_output=True, text=True, timeout=30
    )
    return completed.stdout.split("\n")[:-1] if completed.stdout.endswith("\n") else completed.stdout.split("\n")


def main():
    if not (ROOT / "run.sh").exists():
        RESULTS.append({"name": "run.sh exists", "passed": False, "detail": "missing"})
    else:
        for name, commands, expected in CASES:
            try:
                actual = run(commands)
                ok = actual == expected
                detail = None if ok else {"expected": expected, "actual": actual[:20]}
            except Exception as error:  # noqa: BLE001
                ok, detail = False, repr(error)
            RESULTS.append({"name": name, "passed": ok, "detail": detail})
    passed = sum(1 for r in RESULTS if r["passed"])
    print(json.dumps({"passed": passed, "total": len(RESULTS), "results": RESULTS}, indent=1))


main()
