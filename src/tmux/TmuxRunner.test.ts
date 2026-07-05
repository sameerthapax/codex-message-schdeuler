import { describe, expect, test } from "vitest";

import { analyzeSubmissionSnapshot } from "./TmuxRunner.js";

describe("analyzeSubmissionSnapshot", () => {
  test("accepts a visible working state", () => {
    const result = analyzeSubmissionSnapshot(
      "› hi\n\n• Working (2s • esc to interrupt)\n\n›",
      "› previous prompt",
      "hi",
    );

    expect(result.accepted).toBe(true);
  });

  test("accepts a visible assistant reply after the submitted prompt", () => {
    const result = analyzeSubmissionSnapshot(
      "› hi\n\n• Hello\n\n›",
      "› previous prompt",
      "hi",
    );

    expect(result.accepted).toBe(true);
  });

  test("rejects a pane that only shows the submitted prompt", () => {
    const result = analyzeSubmissionSnapshot(
      "› hi",
      "› previous prompt",
      "hi",
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("Only the submitted prompt");
  });
});
