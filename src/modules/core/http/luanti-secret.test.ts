import assert from "node:assert/strict";
import test from "node:test";
import { requireLuantiSecret } from "@/modules/core/http/luanti-secret";
import { AppError } from "@/modules/core/http/errors";

function reqWith(header: string | undefined) {
  return { header: (name: string) => (name === "x-luanti-secret" ? header : undefined) };
}

test("throws 503 misconfigured when the injected secret is empty", () => {
  assert.throws(
    () => requireLuantiSecret(reqWith("anything"), ""),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 503);
      assert.equal(err.code, "misconfigured");
      return true;
    }
  );
});

test("throws 401 unauthorized when no header is sent", () => {
  assert.throws(
    () => requireLuantiSecret(reqWith(undefined), "s3cret"),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "unauthorized");
      return true;
    }
  );
});

test("throws 401 unauthorized when the header does not match, same or different length", () => {
  assert.throws(() => requireLuantiSecret(reqWith("wrong"), "s3cret"), AppError); //different length
  assert.throws(() => requireLuantiSecret(reqWith("s3cre1"), "s3cret"), AppError); //same length, mismatched
});

test("passes silently when the header matches the injected secret exactly", () => {
  assert.doesNotThrow(() => requireLuantiSecret(reqWith("s3cret"), "s3cret"));
});

test("empty header never matches a non-empty secret", () => {
  assert.throws(() => requireLuantiSecret(reqWith(""), "s3cret"), AppError);
});
