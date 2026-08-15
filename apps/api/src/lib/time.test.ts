import { describe, expect, it } from 'vitest';
import { dayKey, dayRange, monthKey, monthRange, secondsUntil } from '@deposits/shared';

/**
 * Timezone correctness for IST (Asia/Kolkata, UTC+5:30).
 *
 * The half-hour offset is what makes this worth testing properly: an
 * off-by-one-hour bug would pass in most zones and fail here. Getting a month
 * boundary wrong silently misfiles activity into the wrong month and quietly
 * corrupts every monthly target and advance in the system.
 */

const IST = 'Asia/Kolkata';

describe('monthKey', () => {
  it('uses the IST calendar month, not UTC', () => {
    // 31 Aug 2026 20:30 UTC is 1 Sep 2026 02:00 IST.
    const instant = new Date('2026-08-31T20:30:00Z');
    expect(monthKey(instant, IST)).toBe('2026-09');
    expect(monthKey(instant, 'UTC')).toBe('2026-08');
  });

  it('keeps late-evening IST activity in the same month', () => {
    // 31 Aug 2026 18:00 IST is still August.
    expect(monthKey(new Date('2026-08-31T12:30:00Z'), IST)).toBe('2026-08');
  });

  it('pads single-digit months', () => {
    expect(monthKey(new Date('2026-01-15T00:00:00Z'), IST)).toBe('2026-01');
  });

  it('rolls the year at the December boundary', () => {
    // 31 Dec 2026 19:00 UTC is 1 Jan 2027 00:30 IST.
    expect(monthKey(new Date('2026-12-31T19:00:00Z'), IST)).toBe('2027-01');
  });
});

describe('dayKey', () => {
  it('rolls over at IST midnight, not UTC midnight', () => {
    // 18:30 UTC is exactly 00:00 IST the next day.
    expect(dayKey(new Date('2026-08-15T18:29:00Z'), IST)).toBe('2026-08-15');
    expect(dayKey(new Date('2026-08-15T18:30:00Z'), IST)).toBe('2026-08-16');
  });
});

describe('monthRange', () => {
  it('spans IST month boundaries', () => {
    const { start, end } = monthRange(new Date('2026-08-15T10:00:00Z'), IST);

    // 1 Aug 2026 00:00 IST is 31 Jul 2026 18:30 UTC.
    expect(start.toISOString()).toBe('2026-07-31T18:30:00.000Z');
    // 1 Sep 2026 00:00 IST is 31 Aug 2026 18:30 UTC.
    expect(end.toISOString()).toBe('2026-08-31T18:30:00.000Z');
  });

  it('produces a range that contains its own instant', () => {
    const instant = new Date('2026-08-31T20:30:00Z'); // 1 Sep IST
    const { start, end } = monthRange(instant, IST);
    expect(instant >= start).toBe(true);
    expect(instant < end).toBe(true);
  });

  it('agrees with monthKey at every boundary', () => {
    // A range and a key that disagree would make counters and filters differ.
    for (const iso of [
      '2026-01-01T00:00:00Z',
      '2026-02-28T18:29:59Z',
      '2026-02-28T18:30:00Z',
      '2026-12-31T18:30:00Z',
      '2027-03-31T18:29:00Z',
    ]) {
      const instant = new Date(iso);
      const { start, end } = monthRange(instant, IST);
      expect(monthKey(start, IST), `start of range for ${iso}`).toBe(monthKey(instant, IST));
      expect(monthKey(new Date(end.getTime() - 1), IST), `end of range for ${iso}`).toBe(
        monthKey(instant, IST),
      );
    }
  });

  it('handles February in a leap year', () => {
    const { start, end } = monthRange(new Date('2028-02-15T00:00:00Z'), IST);
    expect(start.toISOString()).toBe('2028-01-31T18:30:00.000Z');
    expect(end.toISOString()).toBe('2028-02-29T18:30:00.000Z');
  });
});

describe('dayRange', () => {
  it('is exactly 24 hours', () => {
    const { start, end } = dayRange(new Date('2026-08-15T10:00:00Z'), IST);
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });

  it('starts at IST midnight', () => {
    const { start } = dayRange(new Date('2026-08-15T10:00:00Z'), IST);
    expect(start.toISOString()).toBe('2026-08-14T18:30:00.000Z');
  });
});

describe('secondsUntil', () => {
  const now = new Date('2026-08-15T10:00:00Z');

  it('rounds up so a countdown never displays zero while time remains', () => {
    expect(secondsUntil(new Date('2026-08-15T10:00:00.400Z'), now)).toBe(1);
  });

  it('floors at zero for past timestamps', () => {
    expect(secondsUntil(new Date('2026-08-15T09:00:00Z'), now)).toBe(0);
  });

  it('treats a null target as available now', () => {
    expect(secondsUntil(null, now)).toBe(0);
  });

  it('computes a five-minute lead interval', () => {
    expect(secondsUntil(new Date('2026-08-15T10:05:00Z'), now)).toBe(300);
  });
});
