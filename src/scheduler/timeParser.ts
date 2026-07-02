import { parseDate } from "chrono-node";
import { format, formatDistanceToNowStrict, isAfter } from "date-fns";

export interface ParsedTimeResult {
  date: Date;
  display: string;
}

export function parseScheduledTime(input: string, now = new Date()): ParsedTimeResult {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("A scheduled time is required.");
  }

  const parsed = parseDate(trimmed, now, { forwardDate: true });
  if (!parsed) {
    throw new Error(
      "Could not parse that time. Try values like 05:01, tomorrow 5:01am, 2026-07-02T09:30, in 4h, or in 20m.",
    );
  }

  if (!isAfter(parsed, now)) {
    throw new Error("Scheduled time must be in the future.");
  }

  return {
    date: parsed,
    display: formatScheduledTime(parsed),
  };
}

export function formatScheduledTime(date: Date, now = new Date()): string {
  return `${format(date, "PPP p")} (${formatDistanceToNowStrict(date, { addSuffix: true, roundingMethod: "floor" })})`;
}
