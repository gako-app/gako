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

import { clipboardKey, platformOf } from '../src/clipboardkeys.ts';

const key = (k: string, mods: string[] = [], type = 'keydown') => ({
  type, key: k,
  ctrlKey: mods.includes('ctrl'), shiftKey: mods.includes('shift'), altKey: mods.includes('alt'), metaKey: mods.includes('meta'),
});

test('the platform comes from navigator.platform', () => {
  assert.equal(platformOf('MacIntel'), 'mac');
  assert.equal(platformOf('Win32'), 'windows');
  assert.equal(platformOf('Linux x86_64'), 'linux');
});

test('copy and paste keys off macOS', () => {
  for (const p of ['windows', 'linux'] as const) {
    assert.equal(clipboardKey(key('C', ['ctrl', 'shift']), p, false), 'copy');
    assert.equal(clipboardKey(key('V', ['ctrl', 'shift']), p, false), 'paste');
    assert.equal(clipboardKey(key('Insert', ['ctrl']), p, false), 'copy');
    assert.equal(clipboardKey(key('Insert', ['shift']), p, false), 'paste');
    // Ctrl+V stays with the program (the agents paste images with it), as does Ctrl+C on Linux.
    assert.equal(clipboardKey(key('v', ['ctrl']), p, true), null);
    assert.equal(clipboardKey(key('C', ['ctrl', 'shift'], 'keyup'), p, true), null);
    assert.equal(clipboardKey(key('c', ['ctrl', 'alt']), p, true), null);
  }
  assert.equal(clipboardKey(key('c', ['ctrl']), 'linux', true), null);
});

test('Ctrl+C on Windows copies only while text is selected', () => {
  assert.equal(clipboardKey(key('c', ['ctrl']), 'windows', true), 'copy');
  assert.equal(clipboardKey(key('c', ['ctrl']), 'windows', false), null);
});

test('macOS leaves copy and paste to the app menu', () => {
  for (const k of [key('C', ['ctrl', 'shift']), key('c', ['meta']), key('Insert', ['shift'])]) {
    assert.equal(clipboardKey(k, 'mac', true), null);
  }
});
