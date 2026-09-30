import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pythonCacheDirectory } from "../../../../src/core/python-cache.js";
import type { Result } from "../../../../src/core/result.js";
import type { ProductCheck } from "../../../../src/workflow/product/model.js";
import {
  productComparisonEnvironmentDigest,
  productSourceDigest,
} from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";

const setups: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(setups.splice(0).map(({ workspace }) => workspace.destroy()));
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function fixture() {
  const setup = await productWorkspace();
  setups.push(setup);
  return { setup, state: await setup.workspace.state() };
}

const HOST_VARIABLES = [
  "TERM",
  "COLUMNS",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
];
// Everything a reader may differ in without the product having changed.
const TOOLCHAIN_VARIABLES: readonly [string, string][] = [
  ["NODE_OPTIONS", "--no-warnings"],
  ["PYTHONPATH", "/somewhere"],
  ["LANG", "xx_XX.UTF-8"],
  ["LC_ALL", "xx_XX.UTF-8"],
  ["TZ", "Pacific/Auckland"],
  ["CI", "1"],
  ["CHROME_BIN", "/elsewhere/chrome"],
];

it("keeps the subject across host, terminal and toolchain differences of the reader", async () => {
  const { setup, state } = await fixture();
  const before = value(await productSourceDigest(state, setup.brief));
  for (const name of HOST_VARIABLES) vi.stubEnv(name, "changed-host-context");
  for (const [name, changed] of TOOLCHAIN_VARIABLES) vi.stubEnv(name, changed);
  vi.stubEnv("PATH", `${process.env.PATH}${delimiter}/opt/extra/bin`);
  expect(value(await productSourceDigest(state, setup.brief))).toEqual(before);
});

it("compares neither PATH text nor terminal and host session variables", async () => {
  const { setup, state } = await fixture();
  const check = setup.brief.checks[0] as ProductCheck;
  const comparison = value(await productComparisonEnvironmentDigest(state, setup.brief));
  const forCheck = value(await productComparisonEnvironmentDigest(state, setup.brief, { check }));
  for (const name of [...HOST_VARIABLES, "TMPDIR", "XDG_RUNTIME_DIR"])
    vi.stubEnv(name, "changed-host-context");
  vi.stubEnv("PATH", `${process.env.PATH}${delimiter}/opt/extra/bin`);
  expect(value(await productComparisonEnvironmentDigest(state, setup.brief))).toEqual(comparison);
  expect(value(await productComparisonEnvironmentDigest(state, setup.brief, { check }))).toEqual(
    forCheck,
  );
});

it.each(TOOLCHAIN_VARIABLES.filter(([name]) => name !== "CHROME_BIN"))(
  "compares a changed %s",
  async (name, changed) => {
    const { setup, state } = await fixture();
    const comparison = value(await productComparisonEnvironmentDigest(state, setup.brief));
    vi.stubEnv(name, changed);
    expect(value(await productComparisonEnvironmentDigest(state, setup.brief))).not.toEqual(
      comparison,
    );
  },
);

it("compares the browser by its resolved file and size, not by touching it", async () => {
  const { setup, state } = await fixture();
  const directory = join(setup.workspace.root, ".visp");
  const chrome = join(directory, "chrome");
  await mkdir(directory, { recursive: true });
  await writeFile(chrome, "browser-one");
  await chmod(chrome, 0o700);
  vi.stubEnv("CHROME_BIN", chrome);
  const comparison = value(await productComparisonEnvironmentDigest(state, setup.brief));
  await writeFile(chrome, "browser-one");
  await chmod(chrome, 0o700);
  expect(value(await productComparisonEnvironmentDigest(state, setup.brief))).toEqual(comparison);
  await writeFile(chrome, "a larger browser build");
  expect(value(await productComparisonEnvironmentDigest(state, setup.brief))).not.toEqual(
    comparison,
  );
});

it("compares the executable a check's argv0 selects, so a PATH shim of node or python is another toolchain", async () => {
  const { setup, state } = await fixture();
  const shims = join(setup.workspace.root, ".visp", "shims");
  await mkdir(shims, { recursive: true });
  await writeFile(join(shims, "tool"), "#!/bin/sh\nexit 0\n");
  await chmod(join(shims, "tool"), 0o700);
  const check = {
    ...(setup.brief.checks[0] as ProductCheck),
    command: ["tool", "--version"] as [string, ...string[]],
  };
  const bin = join(setup.workspace.root, ".visp", "real");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "tool"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "tool"), 0o700);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  const real = value(await productComparisonEnvironmentDigest(state, setup.brief, { check }));
  vi.stubEnv("PATH", `${shims}${delimiter}${bin}${delimiter}${process.env.PATH}`);
  const shimmed = value(await productComparisonEnvironmentDigest(state, setup.brief, { check }));
  expect(shimmed).not.toEqual(real);
  // The same file under a longer PATH is the same tool.
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}${delimiter}/opt/extra/bin`);
  expect(value(await productComparisonEnvironmentDigest(state, setup.brief, { check }))).toEqual(
    real,
  );
  // A tool that resolves nowhere is not the tool that resolves somewhere.
  vi.stubEnv("PATH", "/nonexistent");
  expect(
    value(await productComparisonEnvironmentDigest(state, setup.brief, { check })),
  ).not.toEqual(real);
});

it("hashes a pinned check's filtered environment", async () => {
  const { setup, state } = await fixture();
  const pinned = {
    ...(setup.brief.checks[0] as ProductCheck),
    id: "PINNED_T001",
  };
  const ordinary = setup.brief.checks[0] as ProductCheck;
  const before = value(
    await productComparisonEnvironmentDigest(state, setup.brief, { check: pinned }),
  );
  const beforeOrdinary = value(
    await productComparisonEnvironmentDigest(state, setup.brief, { check: ordinary }),
  );
  // These never reach a pinned run (it sees only runtime selectors and locale), so they are not its identity.
  vi.stubEnv("NODE_OPTIONS", "--no-warnings");
  vi.stubEnv("TZ", "Pacific/Auckland");
  vi.stubEnv("CI", "1");
  vi.stubEnv("PYTHONPATH", "/somewhere");
  expect(
    value(await productComparisonEnvironmentDigest(state, setup.brief, { check: pinned })),
  ).toEqual(before);
  expect(
    value(await productComparisonEnvironmentDigest(state, setup.brief, { check: ordinary })),
  ).not.toEqual(beforeOrdinary);
  // The locale it does receive still counts.
  vi.stubEnv("LANG", "xx_XX.UTF-8");
  expect(
    value(await productComparisonEnvironmentDigest(state, setup.brief, { check: pinned })),
  ).not.toEqual(before);
});

it("keeps declared application variables in the subject", async () => {
  const { setup, state } = await fixture();
  const brief = {
    ...setup.brief,
    checks: setup.brief.checks.map((check) => ({ ...check, environmentVariables: ["APP_MODE"] })),
  };
  const declared = value(await productSourceDigest(state, brief));
  const comparison = value(await productComparisonEnvironmentDigest(state, brief));
  vi.stubEnv("APP_MODE", "production");
  expect(value(await productSourceDigest(state, brief))).not.toEqual(declared);
  expect(value(await productComparisonEnvironmentDigest(state, brief))).not.toEqual(comparison);
});

async function executable(root: string, path: string, body = "#!/bin/sh\nexit 0\n") {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), body);
  await chmod(join(root, path), 0o755);
}

it("distinguishes two virtual environments whose interpreters are the same system binary", async () => {
  const { setup, state } = await fixture();
  const root = setup.workspace.root;
  for (const name of ["a", "b"]) {
    await mkdir(join(root, ".visp", name, "bin"), { recursive: true });
    await symlink(process.execPath, join(root, ".visp", name, "bin", "python"));
    await writeFile(join(root, ".visp", name, "pyvenv.cfg"), "home = /usr/bin\n");
  }
  const check = {
    ...(setup.brief.checks[0] as ProductCheck),
    command: ["python", "x.py"] as [string, ...string[]],
  };
  const digest = async (name: string) => {
    vi.stubEnv("PATH", `${join(root, ".visp", name, "bin")}${delimiter}${process.env.PATH}`);
    return value(await productComparisonEnvironmentDigest(state, setup.brief, { check }));
  };
  expect(await digest("a")).not.toEqual(await digest("b"));
  expect(await digest("a")).toEqual(await digest("a"));
});

it("does not distinguish plain symlinks to one binary without a venv marker", async () => {
  const { setup, state } = await fixture();
  const root = setup.workspace.root;
  for (const name of ["a", "b"]) {
    await mkdir(join(root, ".visp", name, "bin"), { recursive: true });
    await symlink(process.execPath, join(root, ".visp", name, "bin", "python"));
  }
  const check = {
    ...(setup.brief.checks[0] as ProductCheck),
    command: ["python", "x.py"] as [string, ...string[]],
  };
  const digest = async (name: string) => {
    vi.stubEnv("PATH", `${join(root, ".visp", name, "bin")}${delimiter}${process.env.PATH}`);
    return value(await productComparisonEnvironmentDigest(state, setup.brief, { check }));
  };
  expect(await digest("a")).toEqual(await digest("b"));
});

it.each(["node", "python3", "python"])(
  "sees a shimmed %s behind a shell, npm or make argv0",
  async (name) => {
    const { setup, state } = await fixture();
    const root = setup.workspace.root;
    const shim = join(root, ".visp", "shim");
    await executable(root, `.visp/shim/${name}`, `#!/bin/sh\necho shim-of-${name}\n`);
    for (const argv0 of ["sh", "npm", "pnpm", "make", "bash"]) {
      const check = {
        ...(setup.brief.checks[0] as ProductCheck),
        command: [argv0, "-c", "true"] as [string, ...string[]],
      };
      vi.stubEnv("PATH", process.env.PATH ?? "");
      const plain = value(await productComparisonEnvironmentDigest(state, setup.brief, { check }));
      vi.stubEnv("PATH", `${shim}${delimiter}${process.env.PATH}`);
      const shimmed = value(
        await productComparisonEnvironmentDigest(state, setup.brief, { check }),
      );
      expect(shimmed, `${argv0} with a ${name} shim`).not.toEqual(plain);
      vi.unstubAllEnvs();
    }
  },
);

it.each([
  "PYTEST_ADDOPTS",
  "npm_config_registry",
  "NPM_CONFIG_PREFIX",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5LIB",
  "GOFLAGS",
  "LD_AUDIT",
  "PLAYWRIGHT_BROWSERS_PATH",
  "SHELLOPTS",
  "BASHOPTS",
])("compares a changed %s", async (name) => {
  const { setup, state } = await fixture();
  const check = setup.brief.checks[0] as ProductCheck;
  const before = value(await productComparisonEnvironmentDigest(state, setup.brief, { check }));
  vi.stubEnv(name, "x");
  expect(
    value(await productComparisonEnvironmentDigest(state, setup.brief, { check })),
  ).not.toEqual(before);
});

it("compares HOME for an ordinary check but not for a pinned one", async () => {
  const { setup, state } = await fixture();
  const ordinary = setup.brief.checks[0] as ProductCheck;
  const pinned = { ...ordinary, id: "PINNED_T001" };
  const digest = async (check: ProductCheck) =>
    value(await productComparisonEnvironmentDigest(state, setup.brief, { check }));
  const before = [await digest(ordinary), await digest(pinned)];
  vi.stubEnv("HOME", "/another/home");
  expect(await digest(ordinary)).not.toEqual(before[0]);
  expect(await digest(pinned)).toEqual(before[1]);
});

it("compares an operator's PYTHONPYCACHEPREFIX but not the cache VISP sets", async () => {
  const { setup, state } = await fixture();
  const check = setup.brief.checks[0] as ProductCheck;
  const digest = async () =>
    value(await productComparisonEnvironmentDigest(state, setup.brief, { check }));
  vi.stubEnv("PYTHONPYCACHEPREFIX", undefined);
  const none = await digest();
  vi.stubEnv("PYTHONPYCACHEPREFIX", await pythonCacheDirectory());
  expect(await digest()).toEqual(none);
  vi.stubEnv("PYTHONPYCACHEPREFIX", "/operator/cache-a");
  const a = await digest();
  expect(a).not.toEqual(none);
  vi.stubEnv("PYTHONPYCACHEPREFIX", "/operator/cache-b");
  expect(await digest()).not.toEqual(a);
});
