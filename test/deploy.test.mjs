import { test } from "node:test";
import assert from "node:assert/strict";
import { retryableDeployment } from "../scripts/deploy-policy.mjs";
test("only the observed D1 binding generation failure is retryable", () => {
  assert.equal(
    retryableDeployment(
      "binding DB of type d1 failed to generate. Please try again later or contact support. [code: 10021]",
    ),
    true,
  );
  for (const error of [
    "SyntaxError at worker startup [code: 10021]",
    "Script startup exceeded CPU time limit [code: 10021]",
    "Authentication error [code: 10000]",
    "account has exceeded its limit",
    "binding DB is invalid [code: 10021]",
  ])
    assert.equal(retryableDeployment(error), false, error);
});
