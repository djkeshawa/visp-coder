import unittest

from sheet.engine import Sheet
from sheet.values import show


class StatisticsTest(unittest.TestCase):
    def setUp(self):
        self.sheet = Sheet()

    def result(self, formula):
        self.sheet.set("Z99", "=" + formula)
        return show(self.sheet.value("Z99"))

    def test_statistics_ranges_and_direct_values(self):
        self.sheet.set("A1", "2")
        self.sheet.set("A2", "text")
        self.sheet.set("B1", "8")
        for function in ("AVERAGE", "MEDIAN"):
            with self.subTest(function=function):
                self.assertEqual(self.result(f"{function}(B2:A1,5)"), "5")
                self.assertEqual(self.result(f"{function}(A2)"), "#VALUE!")
                self.assertEqual(self.result(f"{function}(C1:C2)"), "#DIV/0!")
                self.assertEqual(self.result(f"{function}(A2:A2)"), "#DIV/0!")
                self.assertEqual(self.result(f"{function}(C1)"), "0")

    def test_median_sorting(self):
        self.assertEqual(self.result("MEDIAN(10,2,8,3)"), "5.5")
        self.assertEqual(self.result("MEDIAN(9,2,-1)"), "2")

    def test_rounding_modes(self):
        for formula, expected in (("ROUND(2.345,2)", "2.35"),
                                  ("ROUND(-2.5,0)", "-3"),
                                  ("ROUND(-1.005,2)", "-1.01"),
                                  ("ROUNDUP(-1.234,2)", "-1.24"),
                                  ("ROUNDDOWN(-1.239,2)", "-1.23"),
                                  ("ROUNDUP(1.23,2)", "1.23"),
                                  ("ROUNDDOWN(-0.1,0)", "0")):
            with self.subTest(formula=formula):
                self.assertEqual(self.result(formula), expected)

    def test_digits_and_arity(self):
        self.sheet.set("A1", "text")
        for function in ("ROUND", "ROUNDUP", "ROUNDDOWN"):
            for digits in ("-1", "1.5", "11", "A1"):
                with self.subTest(function=function, digits=digits):
                    self.assertEqual(self.result(f"{function}(2.345,{digits})"), "#VALUE!")
            self.assertEqual(self.result(f"{function}(1.234567,10)"), "1.234567")
            for args in ("", "1", "1,2,3"):
                self.assertEqual(self.result(f"{function}({args})"), "#PARSE!")

    def test_error_order_and_cycles(self):
        self.sheet.set("B1", "=1/0")
        self.sheet.set("A2", "=AA1")
        for function in ("AVERAGE", "MEDIAN"):
            self.assertEqual(self.result(f"{function}(A1:B2)"), "#DIV/0!")
            self.assertEqual(self.result(f"{function}(AA1,1/0)"), "#REF!")
            self.assertEqual(self.result(f"{function}(Z99)"), "#CYCLE!")
        for function in ("ROUND", "ROUNDUP", "ROUNDDOWN"):
            self.assertEqual(self.result(f"{function}(AA1,1/0)"), "#REF!")
            self.assertEqual(self.result(f"{function}(1,1/0)"), "#DIV/0!")

    def test_recalculation(self):
        self.sheet.set("A1", "1.234")
        self.sheet.set("A2", "2")
        self.sheet.set("B1", "=ROUNDUP(A1,A2)")
        self.assertEqual(show(self.sheet.value("B1")), "1.24")
        self.sheet.set("A1", "-2.345")
        self.sheet.set("A2", "1")
        self.assertEqual(show(self.sheet.value("B1")), "-2.4")
