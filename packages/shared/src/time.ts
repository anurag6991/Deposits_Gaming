/**
 * Date logic for the application timezone.
 *
 * The server clock stays UTC. Only these helpers convert, and every month
 * boundary, day boundary, "today" counter, and monthKey in the system goes
 * through them. Confirmed timezone is Asia/Kolkata (IST, UTC+5:30) — India
 * observes no daylight saving, so there are no DST boundaries to handle.
 *
 * A lead completed at 02:00 IST on 1 September belongs to September even though
 * UTC still reads 31 August. Getting this wrong silently misfiles activity across
 * month boundaries and quietly corrupts every monthly target.
 */

export const DEFAULT_APP_TIMEZONE = 'Asia/Kolkata';

/** Parts of an instant as seen in the given timezone. */
function zonedParts(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** 'YYYY-MM' in the app timezone. Stored on every activity row. */
export function monthKey(instant: Date, timeZone: string = DEFAULT_APP_TIMEZONE): string {
  const { year, month } = zonedParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' in the app timezone. Used for "today" counters and dedupe keys. */
export function dayKey(instant: Date, timeZone: string = DEFAULT_APP_TIMEZONE): string {
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The UTC instant corresponding to a wall-clock time in the given zone.
 * Works by measuring the zone's offset at that approximate instant and
 * correcting for it.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const seen = zonedParts(new Date(guess), timeZone);
  const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  return new Date(guess - (seenAsUtc - guess));
}

/** [start, end) covering the calendar month containing `instant`, as UTC instants. */
export function monthRange(
  instant: Date,
  timeZone: string = DEFAULT_APP_TIMEZONE,
): { start: Date; end: Date } {
  const { year, month } = zonedParts(instant, timeZone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: zonedTimeToUtc(year, month, 1, timeZone),
    end: zonedTimeToUtc(nextYear, nextMonth, 1, timeZone),
  };
}

/** [start, end) covering the calendar day containing `instant`, as UTC instants. */
export function dayRange(
  instant: Date,
  timeZone: string = DEFAULT_APP_TIMEZONE,
): { start: Date; end: Date } {
  const { year, month, day } = zonedParts(instant, timeZone);
  const start = zonedTimeToUtc(year, month, day, timeZone);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Seconds until `target`, floored at zero. Used for timer countdowns. */
export function secondsUntil(target: Date | null | undefined, now: Date = new Date()): number {
  if (!target) return 0;
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 1000));
}
