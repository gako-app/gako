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
import { readFileSync } from 'node:fs';

import { SECTIONS, joinCommand, splitCommand } from '../src/app/settingsfields.ts';

const root = new URL('../../', import.meta.url);

/** The keys of the core's Settings struct, as the JSON names them. */
function coreKeys(): string[] {
  const rs = readFileSync(new URL('core/gako-core/src/settings.rs', root), 'utf8');
  const body = rs.slice(rs.indexOf('pub struct Settings {'), rs.indexOf('\n}\n', rs.indexOf('pub struct Settings {')));
  return [...body.matchAll(/^\s+pub (\w+):/gm)].map((m) => m[1].replace(/_(\w)/g, (_, c: string) => c.toUpperCase()));
}

test('the settings screen shows every setting once, and settings.md documents each', () => {
  const shown = SECTIONS.flatMap((s) => s.fields.map((f) => f.key as string));
  assert.equal(new Set(shown).size, shown.length, 'a setting shown twice');
  const core = coreKeys();
  assert.ok(core.length >= 20, `only ${core.length} keys read from settings.rs`);
  assert.deepEqual([...shown].sort(), [...core].sort());
  const md = readFileSync(new URL('docs/settings.md', root), 'utf8');
  for (const key of core) assert.match(md, new RegExp(`^\\| \`${key}\` \\|`, 'm'), `${key} isn't in settings.md`);
});

test('command lines split on spaces, with quotes keeping spaces in one argument', () => {
  assert.deepEqual(splitCommand('claude --model opus'), ['claude', '--model', 'opus']);
  assert.deepEqual(splitCommand('  "/Applications/My Editor/bin/ed"  +{line} {file} '), ['/Applications/My Editor/bin/ed', '+{line}', '{file}']);
  assert.deepEqual(splitCommand(`echo '' "it's"`), ['echo', '', "it's"]);
  assert.deepEqual(splitCommand(''), []);
  for (const parts of [['a b', 'c'], ['say "hi"'], [''], ['plain', '--flag=x']]) {
    assert.deepEqual(splitCommand(joinCommand(parts)), parts);
  }
});
