import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, isPlainText } from "../../core/src/index.ts";

test("canonicalize sorts keys at every depth, keeps array order, writes bigint as a string, drops undefined", () => {
  assert.equal(canonicalize({ b: 1, a: { d: [3, 1], c: 2n }, u: undefined }), '{"a":{"c":"2","d":[3,1]},"b":1}');
  assert.equal(canonicalize([{ y: 1, x: 2 }]), '[{"x":2,"y":1}]');
});
test("canonicalize rejects non-finite numbers (a bug upstream, never hashed)", () => {
  assert.throws(() => canonicalize({ a: Number.NaN }), TypeError);
});
test("isPlainText", () => {
  assert.equal(isPlainText("hello", 10), true);
  assert.equal(isPlainText("hello", 4), false);
  assert.equal(isPlainText("a\nb", 10), false);
  assert.equal(isPlainText("a\nb", 10, true), true);
  assert.equal(isPlainText("⁦x", 10, true), false);
  assert.equal(isPlainText(5, 10), false);
});
