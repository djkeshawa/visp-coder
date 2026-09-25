"""Reference implementation used only to validate the spreadsheet oracle."""
import re
import sys

CELL = re.compile(r"^([A-Za-z])([1-9][0-9]?)$")
NUMBER = re.compile(r"^[+-]?\d+(\.\d+)?$")
TOKEN = re.compile(r"\s*(?:(\d+(?:\.\d+)?)|([A-Za-z]+\d*)|(.))")
ERRORS = ("#DIV/0!", "#VALUE!", "#REF!", "#CYCLE!", "#PARSE!")


class Err(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Text(str):
    pass


def cell_name(text):
    match = CELL.match(text)
    return f"{match.group(1).upper()}{int(match.group(2))}" if match else None


def tokenize(source):
    tokens, position = [], 0
    while position < len(source):
        match = TOKEN.match(source, position)
        if not match or match.end() == position:
            break
        position = match.end()
        number, word, symbol = match.groups()
        if number is not None:
            tokens.append(("num", float(number)))
        elif word is not None:
            tokens.append(("word", word.upper()))
        elif symbol is not None and not symbol.isspace():
            tokens.append(("sym", symbol))
    return tokens


def ref(word):
    match = re.match(r"^([A-Z]+)(\d+)$", word)
    if not match:
        return None
    letters, row = match.group(1), int(match.group(2))
    if len(letters) != 1 or not 1 <= row <= 99:
        return ("badref",)
    return ("ref", f"{letters}{row}")


class Parser:
    def __init__(self, tokens):
        self.tokens, self.i = tokens, 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else (None, None)

    def take(self, kind=None, value=None):
        token = self.peek()
        if token[0] is None or (kind and token[0] != kind) or (value and token[1] != value):
            raise Err("#PARSE!")
        self.i += 1
        return token

    def parse(self):
        node = self.additive()
        if self.i != len(self.tokens):
            raise Err("#PARSE!")
        return node

    def additive(self):
        node = self.term()
        while self.peek() in (("sym", "+"), ("sym", "-")):
            node = ("bin", self.take()[1], node, self.term())
        return node

    def term(self):
        node = self.power()
        while self.peek() in (("sym", "*"), ("sym", "/")):
            node = ("bin", self.take()[1], node, self.power())
        return node

    def power(self):
        base = self.unary()
        if self.peek() == ("sym", "^"):
            self.take()
            return ("bin", "^", base, self.power())
        return base

    def unary(self):
        if self.peek() in (("sym", "+"), ("sym", "-")):
            return ("neg" if self.take()[1] == "-" else "pos", self.unary())
        return self.primary()

    def primary(self):
        kind, value = self.peek()
        if kind == "num":
            self.take()
            return ("num", value)
        if kind == "sym" and value == "(":
            self.take()
            node = self.additive()
            self.take("sym", ")")
            return node
        if kind == "word":
            self.take()
            if self.peek() == ("sym", "("):
                if value not in ("SUM", "MIN", "MAX"):
                    raise Err("#PARSE!")
                self.take()
                args = [self.argument()]
                while self.peek() == ("sym", ","):
                    self.take()
                    args.append(self.argument())
                self.take("sym", ")")
                return ("fn", value, args)
            node = ref(value)
            if node is None:
                raise Err("#PARSE!")
            return node
        raise Err("#PARSE!")

    def argument(self):
        start = self.i
        kind, value = self.peek()
        if kind == "word" and self.i + 1 < len(self.tokens) and self.tokens[self.i + 1] == ("sym", ":"):
            first = ref(value)
            self.i += 2
            kind2, value2 = self.take("word")
            second = ref(value2)
            if first is None or second is None:
                raise Err("#PARSE!")
            return ("range", first, second)
        self.i = start
        return self.additive()


class Sheet:
    def __init__(self):
        self.raw = {}
        self.parsed = {}

    def set(self, cell, content):
        self.raw.pop(cell, None)
        self.parsed.pop(cell, None)
        if content == "":
            return
        self.raw[cell] = content
        if content.startswith("="):
            try:
                self.parsed[cell] = Parser(tokenize(content[1:])).parse()
            except Err as error:
                self.parsed[cell] = ("err", error.code)

    def deps(self, node):
        kind = node[0]
        if kind == "ref":
            yield node[1]
        elif kind == "bin":
            yield from self.deps(node[2])
            yield from self.deps(node[3])
        elif kind in ("neg", "pos"):
            yield from self.deps(node[1])
        elif kind == "fn":
            for arg in node[2]:
                yield from self.deps(arg)
        elif kind == "range" and node[1][0] == "ref" and node[2][0] == "ref":
            yield from range_cells(node[1][1], node[2][1])

    def cycle_members(self):
        graph = {cell: set(self.deps(node)) for cell, node in self.parsed.items()}
        members, index, low, stack, on, counter = set(), {}, {}, [], set(), [0]

        def visit(v):
            index[v] = low[v] = counter[0]
            counter[0] += 1
            stack.append(v)
            on.add(v)
            for w in graph.get(v, ()):
                if w not in graph:
                    continue
                if w not in index:
                    visit(w)
                    low[v] = min(low[v], low[w])
                elif w in on:
                    low[v] = min(low[v], index[w])
            if low[v] == index[v]:
                component = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    component.append(w)
                    if w == v:
                        break
                if len(component) > 1 or v in graph.get(v, ()):
                    members.update(component)

        sys.setrecursionlimit(10000)
        for v in graph:
            if v not in index:
                visit(v)
        return members

    def value(self, cell, memo, cycles):
        if cell in memo:
            return memo[cell]
        if cell in cycles:
            memo[cell] = Err("#CYCLE!")
            return memo[cell]
        content = self.raw.get(cell)
        if content is None:
            result = None
        elif cell in self.parsed:
            node = self.parsed[cell]
            result = Err(node[1]) if node[0] == "err" else self.evaluate(node, memo, cycles, top=True)
        elif NUMBER.match(content):
            result = float(content)
        else:
            result = Text(content)
        memo[cell] = result
        return result

    def number(self, value):
        if isinstance(value, Err):
            return value
        if value is None:
            return 0.0
        if isinstance(value, Text):
            return Err("#VALUE!")
        return value

    def evaluate(self, node, memo, cycles, top=False):
        kind = node[0]
        if kind == "num":
            return node[1]
        if kind == "badref":
            return Err("#REF!")
        if kind == "ref":
            value = self.value(node[1], memo, cycles)
            if top:
                return 0.0 if value is None else value
            return value
        if kind in ("neg", "pos"):
            value = self.number(self.evaluate(node[1], memo, cycles))
            if isinstance(value, Err):
                return value
            return -value if kind == "neg" else value
        if kind == "bin":
            left = self.number(self.evaluate(node[2], memo, cycles))
            if isinstance(left, Err):
                return left
            right = self.number(self.evaluate(node[3], memo, cycles))
            if isinstance(right, Err):
                return right
            op = node[1]
            if op == "+":
                return left + right
            if op == "-":
                return left - right
            if op == "*":
                return left * right
            if op == "/":
                return Err("#DIV/0!") if right == 0 else left / right
            return left ** right
        if kind == "fn":
            numbers = []
            for arg in node[2]:
                if arg[0] == "range":
                    if arg[1][0] != "ref" or arg[2][0] != "ref":
                        return Err("#REF!")
                    for cell in range_cells(arg[1][1], arg[2][1]):
                        value = self.value(cell, memo, cycles)
                        if isinstance(value, Err):
                            return value
                        if value is None or isinstance(value, Text):
                            continue
                        numbers.append(value)
                else:
                    value = self.evaluate(arg, memo, cycles)
                    if isinstance(value, Err):
                        return value
                    if isinstance(value, Text):
                        return Err("#VALUE!")
                    numbers.append(0.0 if value is None else value)
            if node[1] == "SUM":
                return sum(numbers)
            if not numbers:
                return 0.0
            return min(numbers) if node[1] == "MIN" else max(numbers)
        raise Err("#PARSE!")


def range_cells(a, b):
    c1, r1, c2, r2 = ord(a[0]), int(a[1:]), ord(b[0]), int(b[1:])
    for row in range(min(r1, r2), max(r1, r2) + 1):
        for col in range(min(c1, c2), max(c1, c2) + 1):
            yield f"{chr(col)}{row}"


def show(value):
    if value is None:
        return ""
    if isinstance(value, Err):
        return value.code
    if isinstance(value, Text):
        return str(value)
    rounded = round(value, 6)
    if rounded == int(rounded):
        return str(int(rounded))
    return f"{rounded:.6f}".rstrip("0").rstrip(".")


def main():
    sheet = Sheet()
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line.strip():
            continue
        parts = line.split(" ", 2)
        command = parts[0].upper()
        cell = cell_name(parts[1]) if len(parts) > 1 else None
        if command == "SET" and cell:
            sheet.set(cell, parts[2] if len(parts) > 2 else "")
        elif command == "CLEAR" and cell and len(parts) == 2:
            sheet.set(cell, "")
        elif command == "GET" and cell and len(parts) == 2:
            print(show(sheet.value(cell, {}, sheet.cycle_members())), flush=True)
        else:
            print("ERROR", flush=True)


main()
