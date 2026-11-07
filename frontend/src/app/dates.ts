// Gako: a workspace app for reviewing and supervising coding agents across many repositories.
// Copyright (C) 2026 João Sena Ribeiro
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU Affero General Public License as published by the Free Software Foundation, either version 3
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
// even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along with this program.
// If not, see <https://www.gnu.org/licenses/>.

// Dates and times as the settings ask: as the system writes them (its region's format, which the
// shell tells, since the page knows only the app's language), or in a fixed format.

import type { SystemDates } from '../boot';

export type DateFormat = 'system' | 'iso' | 'day-month-year' | 'month-day-year';
export type TimeFormat = 'system' | '24-hour' | '12-hour';

let system: SystemDates = { locale: null, hourCycle: null };
let dateFormat: DateFormat = 'system';
let timeFormat: TimeFormat = 'system';
let cached: { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat; both: Intl.DateTimeFormat } | null = null;

/** What the shell says of the system's formats; without it, the page's language decides. */
export function setSystemDates(dates: SystemDates | undefined): void {
  system = dates ?? { locale: null, hourCycle: null };
  cached = null;
}

/** Applies the `dateFormat` and `timeFormat` settings; unknown values count as "system". */
export function configureDates(settings: { dateFormat?: string; timeFormat?: string }): void {
  dateFormat = (['iso', 'day-month-year', 'month-day-year'] as const).find((f) => f === settings.dateFormat) ?? 'system';
  timeFormat = (['24-hour', '12-hour'] as const).find((f) => f === settings.timeFormat) ?? 'system';
  cached = null;
}

function formats(): NonNullable<typeof cached> {
  let locale: string | undefined;
  try {
    if (system.locale && Intl.DateTimeFormat.supportedLocalesOf([system.locale]).length) locale = system.locale;
  } catch { /* not a locale tag: the page's language */ }
  const hourCycle = system.hourCycle ?? undefined;
  if (!cached) {
    cached = {
      date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
      time: new Intl.DateTimeFormat(locale, { timeStyle: 'short', hourCycle }),
      both: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', hourCycle }),
    };
  }
  return cached;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A date with its time, to the minute: "7 Nov 2026, 14:05" as the system writes it in Portugal,
 * "2026-11-07 14:05" in ISO. The fixed formats are written the same in every language: 14:05,
 * 2:05 PM. `epochSeconds` is a Unix time. */
export function formatDateTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const f = formats();
  if (dateFormat === 'system' && timeFormat === 'system') return f.both.format(d);
  const [y, m, day] = [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())];
  const date = dateFormat === 'system' ? f.date.format(d)
    : dateFormat === 'iso' ? `${y}-${m}-${day}` : dateFormat === 'day-month-year' ? `${day}/${m}/${y}` : `${m}/${day}/${y}`;
  const [hour, minute] = [d.getHours(), pad(d.getMinutes())];
  const time = timeFormat === 'system' ? f.time.format(d)
    : timeFormat === '24-hour' ? `${pad(hour)}:${minute}` : `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
  return `${date}${dateFormat === 'system' ? ', ' : ' '}${time}`;
}
