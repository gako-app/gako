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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { configureDates, formatDateTime, setSystemDates } from '../src/app/dates.ts';

// 2026-11-07 14:05 in the local time zone, whatever it is.
const at = new Date(2026, 10, 7, 14, 5).getTime() / 1000;

test('system dates follow the region the shell names, not the language alone', () => {
  configureDates({});
  setSystemDates({ locale: 'en-PT', hourCycle: null });
  assert.equal(formatDateTime(at), '7 Nov 2026, 14:05');
  setSystemDates({ locale: 'en-US', hourCycle: null });
  assert.match(formatDateTime(at), /^Nov 7, 2026, 2:05\sPM$/);
  // macOS's forced 24-hour clock.
  setSystemDates({ locale: 'en-US', hourCycle: 'h23' });
  assert.equal(formatDateTime(at), 'Nov 7, 2026, 14:05');
  // A locale the formatter doesn't know falls back to the page's language rather than failing.
  setSystemDates({ locale: 'not a locale!', hourCycle: null });
  assert.ok(formatDateTime(at).includes('2026'));
});

test('fixed formats, with the time as asked', () => {
  setSystemDates({ locale: 'en-PT', hourCycle: null });
  configureDates({ dateFormat: 'iso', timeFormat: 'system' });
  assert.equal(formatDateTime(at), '2026-11-07 14:05');
  configureDates({ dateFormat: 'day-month-year', timeFormat: '12-hour' });
  assert.equal(formatDateTime(at), '07/11/2026 2:05 PM');
  configureDates({ dateFormat: 'month-day-year', timeFormat: '24-hour' });
  assert.equal(formatDateTime(at), '11/07/2026 14:05');
  configureDates({ dateFormat: 'nonsense', timeFormat: '24-hour' });
  assert.equal(formatDateTime(at), '7 Nov 2026, 14:05');
  configureDates({ dateFormat: 'system', timeFormat: '12-hour' });
  assert.equal(formatDateTime(at), '7 Nov 2026, 2:05 PM');
});
