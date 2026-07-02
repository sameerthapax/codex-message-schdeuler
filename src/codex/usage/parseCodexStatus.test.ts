import { describe, expect, test } from "vitest";

import { parseCodexStatus, parseResetDateText } from "./parseCodexStatus.js";

describe("parseCodexStatus", () => {
  test("parses 5h reset and remaining percent", () => {
    const now = new Date("2026-07-01T23:00:00-05:00");
    const usage = parseCodexStatus(
      "5h limit: [████████████████░░░░] 81% left (resets 04:15 on 2 Jul)",
      now,
    );

    expect(usage.fiveHourRemainingPercent).toBe(81);
    expect(usage.fiveHourReset?.toISOString()).toBe("2026-07-02T09:15:00.000Z");
  });

  test("parses weekly reset and remaining percent", () => {
    const now = new Date("2026-07-01T23:00:00-05:00");
    const usage = parseCodexStatus(
      "Weekly limit: [█████████░░░░░░░░░░░] 45% left (resets 22:52 on 6 Jul)",
      now,
    );

    expect(usage.weeklyRemainingPercent).toBe(45);
    expect(usage.weeklyReset?.toISOString()).toBe("2026-07-07T03:52:00.000Z");
  });

  test("detects stale warning", () => {
    const usage = parseCodexStatus("Warning: limits may be stale - run /status again shortly.");
    expect(usage.staleWarning).toBe(true);
  });

  test("supports am pm variant", () => {
    const now = new Date("2026-07-01T23:00:00-05:00");
    const parsed = parseResetDateText("4:15 AM on 2 Jul", now);
    expect(parsed?.toISOString()).toBe("2026-07-02T09:15:00.000Z");
  });

  test("supports month day variant", () => {
    const now = new Date("2026-07-01T10:00:00-05:00");
    const parsed = parseResetDateText("Jul 2, 5:01 AM", now);
    expect(parsed?.toISOString()).toBe("2026-07-02T10:01:00.000Z");
  });

  test("rolls year forward when parsed reset is behind current date", () => {
    const now = new Date("2026-12-31T23:59:00-06:00");
    const parsed = parseResetDateText("00:15 on 1 Jan", now);
    expect(parsed?.toISOString()).toBe("2027-01-01T06:15:00.000Z");
  });

  test("returns undefined when reset line is missing", () => {
    const usage = parseCodexStatus("No status available");
    expect(usage.fiveHourReset).toBeUndefined();
    expect(usage.weeklyReset).toBeUndefined();
  });

  test("parses boxed status output with wrapped weekly reset and time-only five hour reset", () => {
    const now = new Date("2026-07-02T01:20:00-05:00");
    const usage = parseCodexStatus(
      `╭──────────────────────────────────────────────────────────────────────╮
│  5h limit:             [░░░░░░░░░░░░░░░░░░░░] 0% left (resets 04:15) │
│  Weekly limit:         [██████░░░░░░░░░░░░░░] 32% left               │
│                        (resets 22:52 on 6 Jul)                       │
╰──────────────────────────────────────────────────────────────────────╯`,
      now,
    );

    expect(usage.fiveHourRemainingPercent).toBe(0);
    expect(usage.weeklyRemainingPercent).toBe(32);
    expect(usage.fiveHourReset?.toISOString()).toBe("2026-07-02T09:15:00.000Z");
    expect(usage.weeklyReset?.toISOString()).toBe("2026-07-07T03:52:00.000Z");
  });
});
