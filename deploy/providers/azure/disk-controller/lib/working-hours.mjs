// WIN_WORKER_WORKING_HOURS, for example "Mon-Fri 08:00-18:00 America/Los_Angeles":
// inside these hours the controller keeps at least one active VM, as with a
// minimum of 1, and outside them the configured minimum applies.
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function minutesOf(text, allowEndOfDay) {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours === 24 && minutes === 0 && allowEndOfDay) return 24 * 60;
  return hours <= 23 ? hours * 60 + minutes : null;
}

function dayIndex(text) {
  return DAYS.indexOf(String(text).toLowerCase());
}

/**
 * Parses "<days> <HH:MM>-<HH:MM> <time zone>". Days are Mon to Sun, as single
 * days, ranges (Mon-Fri, Fri-Mon) or comma-separated lists of both. The end
 * time is exclusive and must come after the start; 24:00 ends the day.
 */
export function parseWorkingHours(text) {
  const parts = String(text ?? "").trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error("must be \"<days> <HH:MM>-<HH:MM> <time zone>\", for example \"Mon-Fri 08:00-18:00 America/Los_Angeles\".");
  }
  const [daysText, timesText, timeZone] = parts;
  const days = new Set();
  for (const item of daysText.split(",")) {
    const range = item.split("-");
    const first = dayIndex(range[0] ?? "");
    const last = range.length === 2 ? dayIndex(range[1] ?? "") : first;
    if (range.length > 2 || first < 0 || last < 0) throw new Error(`has an unknown day list "${daysText}"; use Mon to Sun, such as Mon-Fri.`);
    for (let day = first; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === last) break;
    }
  }
  const times = timesText.split("-");
  const start = times.length === 2 ? minutesOf(times[0], false) : null;
  const end = times.length === 2 ? minutesOf(times[1], true) : null;
  if (start === null || end === null || end <= start) {
    throw new Error(`has a time range "${timesText}" that is not HH:MM-HH:MM with the end after the start.`);
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    throw new Error(`names an unknown time zone "${timeZone}".`);
  }
  return Object.freeze({ text: parts.join(" "), days, start, end, timeZone, formatter });
}

/** True when `epochMs` falls inside the working hours. */
export function withinWorkingHours(hours, epochMs) {
  if (!hours) return false;
  const parts = Object.fromEntries(hours.formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  const day = DAYS.indexOf(String(parts.weekday).toLowerCase());
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return hours.days.has(day) && minute >= hours.start && minute < hours.end;
}
