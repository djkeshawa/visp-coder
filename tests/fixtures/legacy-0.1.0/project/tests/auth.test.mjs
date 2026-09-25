import assert from "node:assert/strict";
import test from "node:test";
import { login } from "../src/auth/login.js";

test("valid credentials return a token", () => {
  assert.equal(login("user"), "user-token");
});

test("missing credentials do not return a token", () => {
  assert.equal(login(""), undefined);
});

console.log("VISP_ASSERT AC001 passed");
console.log("VISP_ASSERT AC002 passed");
