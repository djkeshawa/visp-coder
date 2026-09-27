"""Hidden tests for archive-carryover after an intermediate feature raised the item limit to 50000."""
import os
import sys

base = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "archive-carryover", "hidden_test.py")
os.execv(sys.executable, [sys.executable, base, *sys.argv[1:], "--cap", "50000"])
