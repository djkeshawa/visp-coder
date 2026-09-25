import { expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { productCheckSchema } from "../../../../src/workflow/product/model.js";
import { productVerifierDigest } from "../../../../src/workflow/product/verifier-identity.js";

const check = productCheckSchema.parse({
  id: "C1",
  command: ["node", "test/check.mjs"],
  files: ["test/*.mjs", "app.mjs"],
  verifierFiles: ["test/*.mjs"],
});
const snapshot = {
  "test/check.mjs": "assertion",
  "test/helper.mjs": "helper",
  "app.mjs": "broken",
};

it("binds declared helper contents while allowing product repair outside verifier inputs", () => {
  const original = productVerifierDigest(check, snapshot);
  expect(original).toMatch(/^[a-f0-9]{64}$/);
  expect(productVerifierDigest(check, { ...snapshot, "app.mjs": "repaired" })).toBe(original);
  expect(productVerifierDigest(check, { ...snapshot, "test/helper.mjs": "weakened" })).not.toBe(
    original,
  );
  expect(productVerifierDigest(check, { ...snapshot, "test/new.mjs": "new helper" })).not.toBe(
    original,
  );
});

it("does not depend on snapshot enumeration order", () => {
  expect(productVerifierDigest(check, Object.fromEntries(Object.entries(snapshot).reverse()))).toBe(
    productVerifierDigest(check, snapshot),
  );
});

it("does not certify unspecified or incompletely available verifier inputs", () => {
  expect(productVerifierDigest({ ...check, verifierFiles: undefined }, snapshot)).toBeUndefined();
  expect(productVerifierDigest({ ...check, verifierFiles: [] }, snapshot)).toBeUndefined();
  expect(
    productVerifierDigest({ ...check, verifierFiles: ["test/*.mjs", "missing.mjs"] }, snapshot),
  ).toBeUndefined();
});

it("does not certify a Node assertion entry omitted from verifier declarations", () => {
  expect(
    productVerifierDigest({ ...check, verifierFiles: ["test/helper.mjs"] }, snapshot),
  ).toBeUndefined();
  expect(
    productVerifierDigest(
      { ...check, command: ["node", "./test/check.mjs"], verifierFiles: ["test/check.mjs"] },
      snapshot,
    ),
  ).toMatch(/^[a-f0-9]{64}$/);
  expect(
    productVerifierDigest(
      {
        ...check,
        command: ["node", "test/check.mjs", "app.mjs"],
        verifierFiles: ["test/check.mjs"],
      },
      snapshot,
    ),
  ).toMatch(/^[a-f0-9]{64}$/);
  expect(
    productVerifierDigest(
      {
        ...check,
        command: ["node", "-e", "require('./test/check.mjs')"],
        verifierFiles: ["test/helper.mjs"],
      },
      snapshot,
    ),
  ).toMatch(/^[a-f0-9]{64}$/);
});

it("binds explicit Node preload and environment files but not auto-discovered tests", () => {
  const withEnvironment = { ...snapshot, "test/check.env": "EXPECTED=2" };
  const preloaded = productCheckSchema.parse({
    ...check,
    command: ["node", "--require", "test/helper.mjs", "test/check.mjs"],
  });
  expect(
    productVerifierDigest({ ...preloaded, verifierFiles: ["test/check.mjs"] }, snapshot),
  ).toBeUndefined();
  expect(productVerifierDigest(preloaded, snapshot)).toMatch(/^[a-f0-9]{64}$/);

  const environment = productCheckSchema.parse({
    ...check,
    command: ["node", "--env-file=test/check.env", "test/check.mjs"],
  });
  expect(productVerifierDigest(environment, withEnvironment)).toBeUndefined();
  expect(
    productVerifierDigest(
      { ...environment, verifierFiles: ["test/*.mjs", "test/check.env"] },
      withEnvironment,
    ),
  ).toMatch(/^[a-f0-9]{64}$/);
  expect(
    productVerifierDigest({ ...check, command: ["node", "--test"] }, snapshot),
  ).toBeUndefined();
});

it("changes identity when the executable command changes", () => {
  expect(
    productVerifierDigest({ ...check, command: ["node", "test/other.mjs"] }, snapshot),
  ).not.toBe(productVerifierDigest(check, snapshot));
});

it("does not certify an exact declared path recorded as missing by the source snapshot", () => {
  expect(
    productVerifierDigest(check, {
      ...snapshot,
      "test/check.mjs": hashValue({ hash: null }),
    }),
  ).toBeUndefined();
});
