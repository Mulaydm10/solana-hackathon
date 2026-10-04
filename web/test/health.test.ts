import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../app/api/health/route.ts";

test("GET /api/health reports program and capabilities", async () => {
  const res = GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.program, "CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV");
  assert.equal(body.ok, true);
});
