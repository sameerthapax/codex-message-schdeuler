import type { CodexUsage } from "./UsageProvider.js";

const MONTHS = new Map([
  ["jan", 0],
  ["feb", 1],
  ["mar", 2],
  ["apr", 3],
  ["may", 4],
  ["jun", 5],
  ["jul", 6],
  ["aug", 7],
  ["sep", 8],
  ["oct", 9],
  ["nov", 10],
  ["dec", 11],
]);

export function parseCodexStatus(rawStatus: string, now = new Date()): CodexUsage {
  const normalizedLines = normalizeStatusLines(rawStatus);
  const fiveHourLine = findLine(normalizedLines, /^5h limit:/i);
  const weeklyLine = findLine(normalizedLines, /^weekly limit:/i);

  return {
    fiveHourReset: fiveHourLine ? extractResetDate(fiveHourLine, now) : undefined,
    weeklyReset: weeklyLine ? extractResetDate(weeklyLine, now) : undefined,
    fiveHourRemainingPercent: fiveHourLine ? extractPercent(fiveHourLine) : undefined,
    weeklyRemainingPercent: weeklyLine ? extractPercent(weeklyLine) : undefined,
    staleWarning: /limits may be stale/i.test(rawStatus),
    rawStatus,
  };
}

function normalizeStatusLines(rawStatus: string): string[] {
  const cleanedLines = rawStatus
    .split("\n")
    .map((line) => stripBoxChrome(line))
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const merged: string[] = [];

  for (const rawLine of cleanedLines) {
    const line = rawLine.trim();
    const previous = merged.at(-1);

    if (
      previous &&
      !/\)\s*$/.test(previous) &&
      /^\(resets\b/i.test(line)
    ) {
      merged[merged.length - 1] = `${previous} ${line}`;
      continue;
    }

    merged.push(line);
  }

  return merged;
}

function stripBoxChrome(line: string): string {
  return line
    .replace(/^[│╭╰─]+\s?/, "")
    .replace(/\s?[│╮╯─]+$/, "");
}

function findLine(lines: string[], pattern: RegExp): string | undefined {
  return lines.find((line) => pattern.test(line));
}

function extractPercent(line: string): number | undefined {
  const match = line.match(/(\d{1,3})%\s+left/i);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

function extractResetDate(line: string, now: Date): Date | undefined {
  const match = line.match(/\(resets\s+(.+)\)$/i);
  if (!match) {
    return undefined;
  }

  return parseResetDateText(match[1].trim(), now);
}

export function parseResetDateText(value: string, now = new Date()): Date | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  return (
    parseTimeOnlyFormat(normalized, now) ??
    parseDayMonthFormat(normalized, now) ??
    parseMonthDayFormat(normalized, now)
  );
}

function parseTimeOnlyFormat(value: string, now: Date): Date | undefined {
  const match = value.match(/^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i);
  if (!match) {
    return undefined;
  }

  const [, hourText, minuteText, meridiem] = match;
  return buildLocalTimeDate({
    hourText,
    minuteText,
    meridiem,
    now,
  });
}

function parseDayMonthFormat(value: string, now: Date): Date | undefined {
  const match = value.match(/^(\d{1,2}):(\d{2})(?:\s*([AP]M))?\s+on\s+(\d{1,2})\s+([A-Za-z]{3,})$/i);
  if (!match) {
    return undefined;
  }

  const [, hourText, minuteText, meridiem, dayText, monthText] = match;
  const month = MONTHS.get(monthText.slice(0, 3).toLowerCase());
  if (month === undefined) {
    return undefined;
  }

  return buildLocalDate({
    hourText,
    minuteText,
    meridiem,
    day: Number(dayText),
    month,
    now,
  });
}

function parseMonthDayFormat(value: string, now: Date): Date | undefined {
  const match = value.match(/^([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i);
  if (!match) {
    return undefined;
  }

  const [, monthText, dayText, hourText, minuteText, meridiem] = match;
  const month = MONTHS.get(monthText.slice(0, 3).toLowerCase());
  if (month === undefined) {
    return undefined;
  }

  return buildLocalDate({
    hourText,
    minuteText,
    meridiem,
    day: Number(dayText),
    month,
    now,
  });
}

function buildLocalDate(input: {
  hourText: string;
  minuteText: string;
  meridiem?: string;
  day: number;
  month: number;
  now: Date;
}): Date {
  const { hour, minute } = normalizeTime(input.hourText, input.minuteText, input.meridiem);
  let year = input.now.getFullYear();
  let candidate = new Date(year, input.month, input.day, hour, minute, 0, 0);
  if (candidate.getTime() < input.now.getTime()) {
    year += 1;
    candidate = new Date(year, input.month, input.day, hour, minute, 0, 0);
  }

  return candidate;
}

function buildLocalTimeDate(input: {
  hourText: string;
  minuteText: string;
  meridiem?: string;
  now: Date;
}): Date {
  const { hour, minute } = normalizeTime(input.hourText, input.minuteText, input.meridiem);
  let candidate = new Date(
    input.now.getFullYear(),
    input.now.getMonth(),
    input.now.getDate(),
    hour,
    minute,
    0,
    0,
  );
  if (candidate.getTime() < input.now.getTime()) {
    candidate = new Date(
      input.now.getFullYear(),
      input.now.getMonth(),
      input.now.getDate() + 1,
      hour,
      minute,
      0,
      0,
    );
  }

  return candidate;
}

function normalizeTime(hourText: string, minuteText: string, meridiem?: string): {
  hour: number;
  minute: number;
} {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  const normalizedMeridiem = meridiem?.toUpperCase();

  if (normalizedMeridiem === "AM" && hour === 12) {
    hour = 0;
  } else if (normalizedMeridiem === "PM" && hour < 12) {
    hour += 12;
  }

  return { hour, minute };
}
