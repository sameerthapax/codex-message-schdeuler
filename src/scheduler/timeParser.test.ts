import { describe, expect, test } from "vitest";

import { parseScheduledTime } from "./timeParser.js";

describe("parseScheduledTime", () => {
  test("parses relative time", () => {
    const now = new Date("2026-07-01T10:00:00-05:00");
    const result = parseScheduledTime("in 20m", now);
    expect(result.date.toISOString()).toBe("2026-07-01T15:20:00.000Z");
  });

  test("rejects past times", () => {
    const now = new Date("2026-07-01T10:00:00-05:00");
    expect(() => parseScheduledTime("2026-07-01T09:00:00-05:00", now)).toThrow(
      "Scheduled time must be in the future.",
    );
  });
});
