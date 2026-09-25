import { describe, expect, it } from "vitest";
import { syntaxOnlyValidationMode } from "../../../../src/workflow/evidence/command-quality.js";
import { productCheckSupportsBehavior } from "../../../../src/workflow/product/check-command.js";

describe("validation command quality", () => {
  it("recognizes Node syntax checks without classifying other -c flags", () => {
    expect(syntaxOnlyValidationMode([process.execPath, "--check", "game.js"])).toBe("--check");
    expect(syntaxOnlyValidationMode([process.execPath, "-c", "game.js"])).toBe("-c");
    expect(syntaxOnlyValidationMode(["python", "-c", "print(1)"])).toBeUndefined();
    expect(syntaxOnlyValidationMode(["vitest", "-c", "vitest.config.ts"])).toBeUndefined();
    expect(
      syntaxOnlyValidationMode(["C:\\Program Files\\nodejs\\node.exe", "--check", "game.js"]),
    ).toBe("--check");
  });

  it("recognizes immediate wrappers without treating script arguments as interpreter flags", () => {
    expect(syntaxOnlyValidationMode(["pnpm", "exec", "node", "--check", "game.js"])).toBe(
      "--check",
    );
    expect(syntaxOnlyValidationMode(["npx", "--", "node", "-c", "game.js"])).toBe("-c");
    expect(syntaxOnlyValidationMode(["npx", "-p", "node", "node", "--check", "game.js"])).toBe(
      "--check",
    );
    expect(
      syntaxOnlyValidationMode([
        "npm.cmd",
        "exec",
        "--package=node",
        "--",
        "node",
        "-c",
        "game.js",
      ]),
    ).toBe("-c");
    expect(syntaxOnlyValidationMode(["npx.cmd", "--yes", "node", "--check", "game.js"])).toBe(
      "--check",
    );
    expect(syntaxOnlyValidationMode(["npx", "-p", "node", "echo", "--check"])).toBeUndefined();
    expect(syntaxOnlyValidationMode(["node", "test.mjs", "--check"])).toBeUndefined();
    expect(syntaxOnlyValidationMode(["node", "--", "--check"])).toBeUndefined();
    expect(syntaxOnlyValidationMode(["pnpm", "exec", "echo", "node", "--check"])).toBeUndefined();
  });

  it("keeps executable tests behavioral while rejecting syntax-only checks", () => {
    expect(
      productCheckSupportsBehavior({
        id: "C001",
        command: [process.execPath, "--check", "game.js"],
        outcomes: ["O001"],
        files: ["game.js"],
        environment: "node",
      }),
    ).toBe(false);
    expect(
      productCheckSupportsBehavior({
        id: "C002",
        command: ["python", "-c", "print(1)"],
        outcomes: ["O001"],
        files: [],
        environment: "node",
      }),
    ).toBe(true);
    expect(
      productCheckSupportsBehavior({
        id: "C003",
        command: ["vitest", "-c", "vitest.config.ts"],
        outcomes: ["O001"],
        files: [],
        environment: "node",
      }),
    ).toBe(true);
  });
});
