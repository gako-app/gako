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

import { isCloseTab } from '../src/tabkeys.ts';

const key = (k: string, mods: string[] = []) => ({
  key: k, ctrlKey: mods.includes('ctrl'), shiftKey: mods.includes('shift'), altKey: mods.includes('alt'), metaKey: mods.includes('meta'),
});

test('⌘W closes any tab on macOS, and Ctrl+W stays with the program', () => {
  for (const inTerminal of [false, true]) {
    assert.equal(isCloseTab(key('w', ['meta']), 'mac', inTerminal), true);
    assert.equal(isCloseTab(key('w', ['ctrl']), 'mac', inTerminal), false);
    assert.equal(isCloseTab(key('W', ['meta', 'shift']), 'mac', inTerminal), false);
  }
});

test('Ctrl+W closes file tabs off macOS', () => {
  for (const p of ['windows', 'linux'] as const) {
    assert.equal(isCloseTab(key('w', ['ctrl']), p, false), true);
    assert.equal(isCloseTab(key('W', ['ctrl', 'shift']), p, false), false);
    assert.equal(isCloseTab(key('w', ['ctrl', 'alt']), p, false), false);
    assert.equal(isCloseTab(key('w', ['meta']), p, false), false);
    assert.equal(isCloseTab(key('q', ['ctrl']), p, false), false);
  }
});

test('Ctrl+W closes a terminal on Windows; on Linux it stays with the shell', () => {
  assert.equal(isCloseTab(key('w', ['ctrl']), 'windows', true), true);
  assert.equal(isCloseTab(key('w', ['ctrl']), 'linux', true), false);
  for (const p of ['windows', 'linux'] as const) {
    assert.equal(isCloseTab(key('W', ['ctrl', 'shift']), p, true), true);
  }
});
