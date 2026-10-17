// Strict parser for the Date header, hand-rolled because JavaScript's built-in parser rolls
// impossible dates over (31 Apr 2001 becomes 1 May) instead of rejecting them. A date we cannot
// trust is reported by status, never shifted, so window arithmetic only ever sees real dates.
import type { ParsedDate } from '../types.ts';

// Inclusive, in UTC. Dates outside it are valid but implausible for this archive.
export const USABLE_WINDOW = { from: '1998-01-01T00:00:00Z', to: '2002-12-31T23:59:59Z' } as const;

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// [weekday ","] day month year HH:MM[:SS] +HHMM [(comment)], e.g. "Fri, 14 Dec 2001 08:11:23 -0800 (PST)".
// Shape only; every number is range-checked after the match.
const SHAPE =
  /^(?:([A-Za-z]{3}),[ \t]*)?(\d{1,2})[ \t]+([A-Za-z]{3})[ \t]+(\d{4})[ \t]+(\d{2}):(\d{2})(?::(\d{2}))?[ \t]+([+-])(\d{2})(\d{2})(?:[ \t]*\([^()]*\))?$/;

const MINUTES_PER_DAY = 1440;

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

// Days since 1970-01-01 in the proleptic Gregorian calendar, and back (H. Hinnant's algorithms).
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day: doy - Math.floor((153 * mp + 2) / 5) + 1 };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function parseDate(raw: string | null): ParsedDate {
  if (raw === null || raw.trim() === '') return { utc: null, status: 'missing' };
  const unparseable: ParsedDate = { utc: null, status: 'unparseable' };

  const m = SHAPE.exec(raw.trim());
  if (m === null) return unparseable;
  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText, sign, offHText, offMText] = m;
  if (weekday !== undefined && !WEEKDAYS.includes(weekday.toLowerCase())) return unparseable;
  const month = MONTHS.indexOf((monthText as string).toLowerCase()) + 1;
  if (month === 0) return unparseable;

  const year = Number(yearText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const offH = Number(offHText);
  const offM = Number(offMText);
  if (day < 1 || day > daysInMonth(year, month)) return unparseable;
  if (hour > 23 || minute > 59 || second > 59) return unparseable;
  if (offH > 14 || offM > 59) return unparseable;

  // Local wall time minus the offset is UTC; offsets are whole minutes, so seconds carry over.
  const offset = (sign === '-' ? -1 : 1) * (offH * 60 + offM);
  const utcMinutes = daysFromCivil(year, month, day) * MINUTES_PER_DAY + hour * 60 + minute - offset;
  const utcDays = Math.floor(utcMinutes / MINUTES_PER_DAY);
  const minuteOfDay = utcMinutes - utcDays * MINUTES_PER_DAY;
  const d = civilFromDays(utcDays);
  // Fixed-width ISO strings compare in time order only for four-digit years.
  if (d.year < 0 || d.year > 9999) return { utc: null, status: 'out_of_range' };

  const utc =
    `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}T` +
    `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}:${pad(second)}Z`;
  if (utc < USABLE_WINDOW.from || utc > USABLE_WINDOW.to) return { utc: null, status: 'out_of_range' };
  return { utc, status: 'usable' };
}
