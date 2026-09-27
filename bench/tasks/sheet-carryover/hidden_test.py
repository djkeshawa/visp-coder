"""Sheet carryover oracle: hidden_test.py <project_dir> [--stage 1|2].

Core covers the original contract and session 1; new excludes carried decisions.
Every memory check discriminates against omitting the carried decisions.
Each script gets a fresh CLI process, so groups also never share state.
"""
import argparse
import json
import subprocess
from pathlib import Path


# Each check is (name, commands, expected output lines).
CORE = [
    ("values and formatting", ["SET A1 2.50", "SET A2 hello world", "SET A3 =1/3", "GET A1", "GET A2", "GET A3", "GET A4"], ["2.5", "hello world", "0.333333", ""]),
    ("precedence and unary", ["SET A1 =2+3*4", "SET A2 =-2^2", "SET A3 =2^3^2", "GET A1", "GET A2", "GET A3"], ["14", "4", "512"]),
    ("empty and direct text", ["SET B1 text", "SET A1 =B1", "SET A2 =B1+1", "SET A3 =B2+1", "GET A1", "GET A2", "GET A3"], ["text", "#VALUE!", "1"]),
    ("sum reversed range", ["SET A1 2", "SET B1 4", "SET A2 text", "SET C1 =sum(B2:A1,3)", "GET C1"], ["9"]),
    ("min max unchanged", ["SET A1 =MIN(B1:B3)", "SET A2 =MAX(B1:B3)", "SET A3 =MIN(4,-2,8)+MAX(4,-2,8)", "GET A1", "GET A2", "GET A3"], ["0", "0", "6"]),
    ("error order", ["SET A1 =AA1+1/0", "SET B1 =1/0", "SET A2 =AA1", "SET C1 =SUM(A1:B2)", "GET A1", "GET C1"], ["#REF!", "#REF!"]),
    ("parse and missing arguments", ["SET A1 =BOGUS(1)", "SET A2 =SUM()", "SET A3 =1+", "GET A1", "GET A2", "GET A3"], ["#PARSE!"] * 3),
    ("cycles and recovery", ["SET A1 =B1", "SET B1 =A1", "SET C1 =A1+1", "GET C1", "SET B1 4", "GET C1"], ["#CYCLE!", "5"]),
    ("updates and clearing", ["set a1 3", "SET B1 =A1*2", "GET B1", "SET A1 5", "GET B1", "CLEAR A1", "GET B1", "SET A1 7", "SET A1 ", "GET A1"], ["6", "10", "0", ""]),
    ("invalid commands", ["HELLO", "GET AA1", "GET A1 extra", "CLEAR", "SET A100 2", "GET A1"], ["ERROR"] * 5 + [""]),
    ("average values", ["SET A1 =AVERAGE(2,4,9)", "SET A2 =average(-2,2,6)", "GET A1", "GET A2"], ["5", "2"]),
    ("average ranges ignore text and empty", ["SET A1 2", "SET B1 6", "SET A2 text", "SET C1 =AVERAGE(B2:A1,10)", "GET C1"], ["6"]),
    ("average direct text", ["SET A1 text", "SET B1 =AVERAGE(A1,2)", "GET B1"], ["#VALUE!"]),
    ("average propagates errors", ["SET B1 =1/0", "SET A2 =AA1", "SET C1 =AVERAGE(A1:B2)", "SET C2 =AVERAGE(AA1,1/0)", "GET C1", "GET C2"], ["#DIV/0!", "#REF!"]),
    ("average no numbers", ["SET A1 text", "SET C1 =AVERAGE(B1:B3)", "SET C2 =AVERAGE(A1:A2)", "GET C1", "GET C2"], ["#DIV/0!"] * 2),
    ("round half away from zero", ["SET A1 =ROUND(2.5,0)", "SET A2 =ROUND(-2.5,0)", "SET A3 =ROUND(2.345,2)", "SET A4 =ROUND(-2.345,2)", "GET A1", "GET A2", "GET A3", "GET A4"], ["3", "-3", "2.35", "-2.35"]),
    ("round values and digit boundaries", ["SET A1 =ROUND(1.234,2)", "SET A2 =ROUND(-1.234,2)", "SET A3 =ROUND(1.234567,10)", "GET A1", "GET A2", "GET A3"], ["1.23", "-1.23", "1.234567"]),
    ("round negative digits", ["SET A1 =ROUND(12.34,-1)", "GET A1"], ["#VALUE!"]),
    ("round fractional digits", ["SET A1 =ROUND(12.34,1.5)", "GET A1"], ["#VALUE!"]),
    ("round oversized digits", ["SET A1 =ROUND(12.34,11)", "GET A1"], ["#VALUE!"]),
    ("round text digits", ["SET B1 text", "SET A1 =ROUND(12.34,B1)", "GET A1"], ["#VALUE!"]),
    ("round argument count", ["SET A1 =ROUND(1)", "SET A2 =ROUND(1,2,3)", "SET A3 =ROUND(1,0)", "GET A1", "GET A2", "GET A3"], ["#PARSE!", "#PARSE!", "1"]),
]

NEW = [
    ("median odd and unsorted", ["SET A1 =MEDIAN(9,1,4)", "GET A1"], ["4"]),
    ("median even", ["SET A1 =MEDIAN(10,2,8,3)", "GET A1"], ["5.5"]),
    ("median ranges ignore text and empty", ["SET A1 8", "SET B1 2", "SET A2 text", "SET C1 =median(B2:A1,5)", "GET C1"], ["5"]),
    ("median direct text", ["SET A1 text", "SET B1 =MEDIAN(A1,3)", "GET B1"], ["#VALUE!"]),
    ("median error order", ["SET B1 =1/0", "SET A2 =AA1", "SET C1 =MEDIAN(A1:B2)", "SET C2 =MEDIAN(AA1,1/0)", "GET C1", "GET C2"], ["#DIV/0!", "#REF!"]),
    ("median singleton and duplicates", ["SET A1 =MEDIAN(-4)", "SET A2 =MEDIAN(2,2,9,2)", "GET A1", "GET A2"], ["-4", "2"]),
    ("roundup positive", ["SET A1 =ROUNDUP(1.2341,0)", "SET A2 =ROUNDUP(1.2341,1)", "SET A3 =ROUNDUP(1.2341,2)", "SET A4 =ROUNDUP(1.2341,3)", "GET A1", "GET A2", "GET A3", "GET A4"], ["2", "1.3", "1.24", "1.235"]),
    ("roundup negative", ["SET A1 =ROUNDUP(-1.2341,0)", "SET A2 =ROUNDUP(-1.2341,1)", "SET A3 =ROUNDUP(-1.2341,2)", "SET A4 =ROUNDUP(-1.2341,3)", "GET A1", "GET A2", "GET A3", "GET A4"], ["-2", "-1.3", "-1.24", "-1.235"]),
    ("rounddown positive", ["SET A1 =ROUNDDOWN(1.2349,0)", "SET A2 =ROUNDDOWN(1.2349,1)", "SET A3 =ROUNDDOWN(1.2349,2)", "SET A4 =ROUNDDOWN(1.2349,3)", "GET A1", "GET A2", "GET A3", "GET A4"], ["1", "1.2", "1.23", "1.234"]),
    ("rounddown negative", ["SET A1 =ROUNDDOWN(-1.2349,0)", "SET A2 =ROUNDDOWN(-1.2349,1)", "SET A3 =ROUNDDOWN(-1.2349,2)", "SET A4 =ROUNDDOWN(-1.2349,3)", "GET A1", "GET A2", "GET A3", "GET A4"], ["-1", "-1.2", "-1.23", "-1.234"]),
    ("rounding exact values and zero", ["SET A1 =ROUNDUP(1.23,2)", "SET A2 =ROUNDDOWN(-1.23,2)", "SET A3 =ROUNDUP(0,3)", "SET A4 =ROUNDDOWN(-0.1,0)", "GET A1", "GET A2", "GET A3", "GET A4"], ["1.23", "-1.23", "0", "0"]),
    ("wrong argument counts", [f"SET A1 ={formula}\nGET A1" for formula in ("MEDIAN()", "ROUNDUP()", "ROUNDUP(1)", "ROUNDUP(1,2,3)", "ROUNDDOWN()", "ROUNDDOWN(1)", "ROUNDDOWN(1,2,3)")], ["#PARSE!"] * 7),
    ("number errors propagate", ["SET B1 text", "SET A1 =ROUNDUP(AA1,2)", "SET A2 =ROUNDDOWN(1/0,2)", "SET A3 =ROUNDUP(B1,2)", "GET A1", "GET A2", "GET A3"], ["#REF!", "#DIV/0!", "#VALUE!"]),
    ("referenced values and digits update", ["SET A1 1.234", "SET A2 2", "SET B1 =ROUNDUP(A1,A2)", "SET B2 =ROUNDDOWN(A1,A2)", "SET B3 =MEDIAN(A1:A2,3)", "GET B1", "GET B2", "GET B3", "SET A1 -2.345", "SET A2 1", "GET B1", "GET B2", "GET B3"], ["1.24", "1.23", "2", "-2.4", "-2.3", "1"]),
]

MEMORY = [
    ("median empty range", ["SET A1 =MEDIAN(B1:B3)", "GET A1"], ["#DIV/0!"]),
    ("median text-only range", ["SET B1 text", "SET B2 other", "SET A1 =MEDIAN(B1:B2)", "GET A1"], ["#DIV/0!"]),
    ("roundup negative digits", ["SET A1 =ROUNDUP(12.34,-1)", "GET A1"], ["#VALUE!"]),
    ("roundup fractional digits", ["SET A1 =ROUNDUP(12.34,1.5)", "GET A1"], ["#VALUE!"]),
    # Include rejection with the positive control: permissive digits must fail this check too.
    ("roundup digit boundary", ["SET A1 =ROUNDUP(1.234567,10)", "SET A2 =ROUNDUP(1.234567,11)", "GET A1", "GET A2"], ["1.234567", "#VALUE!"]),
    ("roundup text digits", ["SET B1 text", "SET A1 =ROUNDUP(12.34,B1)", "GET A1"], ["#VALUE!"]),
    ("rounddown oversized digits", ["SET A1 =ROUNDDOWN(12.34,11)", "GET A1"], ["#VALUE!"]),
    ("rounddown negative digits", ["SET A1 =ROUNDDOWN(12.34,-1)", "GET A1"], ["#VALUE!"]),
]


def check(root, name, commands, expected):
    try:
        completed = subprocess.run(["./run.sh"], cwd=root, input="\n".join(commands) + "\n",
                                   capture_output=True, text=True, timeout=30)
        actual = completed.stdout.splitlines()
        ok = completed.returncode == 0 and actual == expected
        detail = None if ok else {"expected": expected, "actual": actual[:20],
                                  "returncode": completed.returncode, "stderr": completed.stderr[-1000:]}
    except Exception as error:  # noqa: BLE001
        ok, detail = False, repr(error)
    return {"name": name, "passed": ok, "detail": detail}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path)
    parser.add_argument("--stage", type=int, choices=(1, 2), default=2)
    args = parser.parse_args()
    groups = [("", CORE)] if args.stage == 1 else [("", CORE), ("new:", NEW), ("memory:", MEMORY)]
    results = [check(args.project_dir.resolve(), prefix + name, commands, expected)
               for prefix, cases in groups for name, commands, expected in cases]
    print(json.dumps({"passed": sum(r["passed"] for r in results), "total": len(results),
                      "results": results}, indent=2))


if __name__ == "__main__":
    main()
