// The "Watch the demo mission" link (#187): only for well-formed addresses, never anything injected via env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoMissionLink } from "../lib/public-config";

const M = "3rcjAQMTKKLJZfEqYmWFZT5eeJK11fYRge1wGxLdycec";
const F = "BKqc5JaWK1q5hgYqjkQa84aKfsoQAY1E6TgXgm7A4XQ8";

test("demoMissionLink: a read-only mission link, or nothing", () => {
  assert.equal(demoMissionLink(M, F), `/missions?m=${M}&fee=${F}`);
  assert.equal(demoMissionLink(M, undefined), `/missions?m=${M}`);
  assert.equal(demoMissionLink(M, "javascript:alert(1)"), `/missions?m=${M}`);
  assert.equal(demoMissionLink(undefined, F), null);
  assert.equal(demoMissionLink("", F), null);
  assert.equal(demoMissionLink(`${M}&fee=x`, F), null);
});
