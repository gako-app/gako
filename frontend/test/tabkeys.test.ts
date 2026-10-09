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

import { tabKey } from '../src/app/tabkeys.ts';

const key = (k: string, mods: string[] = [], type = 'keydown') => ({
  type, key: k,
  ctrlKey: mods.includes('ctrl'), shiftKey: mods.includes('shift'), altKey: mods.includes('alt'), metaKey: mods.includes('meta'),
});

test('⌘W closes the tab on macOS, a terminal included', () => {
  for (const inTerminal of [false, true]) {
    assert.equal(tabKey(key('w', ['meta']), true, inTerminal), 'close');
    // Ctrl+W stays with the shell, and ⌘⇧W is left alone.
    assert.equal(tabKey(key('w', ['ctrl']), true, inTerminal), null);
    assert.equal(tabKey(key('W', ['meta', 'shift']), true, inTerminal), null);
    assert.equal(tabKey(key('F4', ['ctrl']), true, inTerminal), null);
  }
});

test('Ctrl+W closes the tab off macOS, except inside a terminal', () => {
  assert.equal(tabKey(key('w', ['ctrl']), false, false), 'close');
  assert.equal(tabKey(key('w', ['ctrl']), false, true), null);
});

test('Ctrl+Shift+W and Ctrl+F4 close the tab off macOS, a terminal included', () => {
  for (const inTerminal of [false, true]) {
    assert.equal(tabKey(key('W', ['ctrl', 'shift']), false, inTerminal), 'close');
    assert.equal(tabKey(key('F4', ['ctrl']), false, inTerminal), 'close');
    // Alt+F4 closes the window, which the system does; the rest go on.
    assert.equal(tabKey(key('F4', ['alt']), false, inTerminal), null);
    assert.equal(tabKey(key('F4', ['ctrl', 'alt']), false, inTerminal), null);
    assert.equal(tabKey(key('W', ['ctrl', 'shift'], 'keyup'), false, inTerminal), null);
    assert.equal(tabKey(key('w', ['meta']), false, inTerminal), null);
  }
});

test('Ctrl+Tab and Ctrl+Shift+Tab step through the tabs', () => {
  for (const mac of [false, true]) {
    assert.equal(tabKey(key('Tab', ['ctrl']), mac, true), 'next');
    assert.equal(tabKey(key('Tab', ['ctrl', 'shift']), mac, false), 'prev');
    assert.equal(tabKey(key('Tab'), mac, false), null);
    assert.equal(tabKey(key('Tab', ['ctrl', 'alt']), mac, false), null);
  }
});
