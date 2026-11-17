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

import { dissolveSmall, groupName, join, leave, moveUnit, unitsOf } from '../src/app/groups.ts';

interface T { name: string; group: string | null }
const make = (spec: string): T[] => spec.split(' ').map((s) => {
  const [name, group] = s.split(':');
  return { name, group: group ?? null };
});
const show = (list: T[]) => list.map((t) => (t.group ? `${t.name}:${t.group}` : t.name)).join(' ');

test('a group is one unit, a lone entry another', () => {
  const list = make('a b:g c:g d');
  assert.deepEqual(unitsOf(list).map((u) => u.map((t) => t.name).join('')), ['a', 'bc', 'd']);
});

test('a group moves as one, before or after the others', () => {
  let list = make('a b:g c:g d');
  let units = unitsOf(list);
  moveUnit(list, units, units[1], 0);
  assert.equal(show(list), 'b:g c:g a d');
  list = make('a b:g c:g d');
  units = unitsOf(list);
  moveUnit(list, units, units[1], 2);
  assert.equal(show(list), 'a d b:g c:g');
  units = unitsOf(list);
  moveUnit(list, units, units[0], 1);
  assert.equal(show(list), 'd a b:g c:g');
});

test('an entry moves within its group', () => {
  const list = make('a b:g c:g e:g d');
  const members = list.filter((t) => t.group === 'g').map((t) => [t]);
  moveUnit(list, members, members[2], 0);
  assert.equal(show(list), 'a e:g b:g c:g d');
  moveUnit(list, members, members[2], 2);
  assert.equal(show(list), 'a b:g c:g e:g d');
});

test('joining puts an entry after the group; leaving, just after it', () => {
  const list = make('a b:g c:g d');
  join(list, list[0], 'g');
  assert.equal(show(list), 'b:g c:g a:g d');
  leave(list, list[0]);
  assert.equal(show(list), 'c:g a:g b d');
});

test('a group of one is dissolved', () => {
  const list = make('a:g b c:h d:h');
  assert.equal(dissolveSmall(list), true);
  assert.equal(show(list), 'a b c:h d:h');
  assert.equal(dissolveSmall(list), false);
});

test('a new group takes the lowest number free', () => {
  assert.equal(groupName([]), 'Group 1');
  assert.equal(groupName(['Group 1', 'Reviews', 'Group 3']), 'Group 2');
});
