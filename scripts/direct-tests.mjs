#!/usr/bin/env node
// Prints the test files that cover the given src files, one per line, so the inner loop is
//   pnpm exec vitest run $(node scripts/direct-tests.mjs src/core/exec.ts) --bail=1
// A test covers a module when it imports it directly (the import specifier resolves to the
// module) or is named after it: tests/<kind>/<area>/X.test.ts for src/<area>/**/X.ts, and
// tests/unit/workflow/evidence/product-X.test.ts for src/workflow/product/X.ts.
// With no match it prints NO_MATCH, a path no test file contains, so vitest stops with "No test
// files found" instead of running the whole suite on an empty list; the reason goes to stderr.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (path) => path.split(sep).join("/");

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : testFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const tests = testFiles(join(root, "tests")).map((path) => ({
  path,
  relative: posix(relative(root, path)),
  text: readFileSync(path, "utf8"),
}));
const specifier = /["'](\.{1,2}\/[^"']*?)\.js["']/g;

function importedModules(test) {
  const modules = new Set();
  for (const [, spec] of test.text.matchAll(specifier)) {
    modules.add(posix(relative(root, resolve(dirname(test.path), spec))));
  }
  return modules;
}

function nameMatches(source, test) {
  const parts = source.replace(/\.ts$/, "").split("/"); // src, area, ..., X
  const name = parts.at(-1);
  const area = parts[1];
  const names = [`${name}.test.ts`];
  if (source.startsWith("src/workflow/product/")) names.push(`product-${name}.test.ts`);
  const segments = test.relative.split("/"); // tests, kind, area, ..., file
  return segments[2] === area && names.includes(segments.at(-1));
}

const NO_MATCH = "tests/__no_direct_tests__";
const requested = process.argv.slice(2);
if (requested.length === 0) {
  console.error("usage: node scripts/direct-tests.mjs <src file>...");
  console.log(NO_MATCH);
  process.exit(2);
}

const imports = new Map(tests.map((test) => [test, importedModules(test)]));
const found = new Set();
for (const argument of requested) {
  if (!existsSync(argument)) {
    console.error(`no such file: ${argument}`);
    continue;
  }
  const source = posix(relative(root, resolve(argument)));
  if (!source.endsWith(".ts")) {
    console.error(`not a .ts file: ${argument}`);
    continue;
  }
  const module = source.replace(/\.ts$/, "");
  let any = false;
  for (const test of tests) {
    if (source === test.relative || imports.get(test).has(module) || nameMatches(source, test)) {
      found.add(test.relative);
      any = true;
    }
  }
  if (!any) {
    const area = source.split("/");
    const hint =
      area[0] === "src" && area.length > 2
        ? `; it is covered through other modules, try tests/unit/${area[1]}`
        : "";
    console.error(`no direct tests for ${source}${hint}`);
  }
}
if (found.size === 0) console.log(NO_MATCH);
for (const path of [...found].sort()) console.log(path);
