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

import { CombiningCap, capCombining } from '../src/combining.ts';

const enc = new TextEncoder();
const marks = (n: number) => '́'.repeat(n);
const stream = (cap: CombiningCap, text: string, cuts: number[]) => {
  const b = enc.encode(text);
  let out = '';
  let at = 0;
  for (const c of [...cuts, b.length]) {
    out += cap.apply(b.slice(at, c));
    at = c;
  }
  return out + cap.flush();
};

test('runs up to the limit stay, longer runs go whole', () => {
  const c = new CombiningCap(4);
  assert.equal(c.apply(enc.encode(`a${marks(20)}b${marks(3)}c${marks(4)}d`)), `ab${marks(3)}c${marks(4)}d`);
});

test('a run split across chunks is judged as one run', () => {
  // 3 + 2 marks: over the limit of 4, so all of it goes.
  assert.equal(stream(new CombiningCap(4), `x a${marks(3)}${marks(2)}b`, [8]), 'x ab');
  // 2 + 2 marks: within the limit, kept, even though the chunk ended mid-run.
  assert.equal(stream(new CombiningCap(4), `x a${marks(2)}${marks(2)}b`, [6]), `x a${marks(4)}b`);
});

test('chunks made only of marks, and a very long run, are handled', () => {
  const text = `q${marks(300)}r${marks(1)}s`;
  const cuts = [3, 50, 51, 400, 600];
  assert.equal(stream(new CombiningCap(4), text, cuts), `qr${marks(1)}s`);
});

test('a UTF-8 sequence split between chunks survives', () => {
  assert.equal(stream(new CombiningCap(4), 'é→日本', [3]), 'é→日本');
});

test('capCombining matches the streaming rule', () => {
  const text = `q${marks(30)} r${marks(4)} s${marks(5)} t${marks(1)}`;
  assert.equal(stream(new CombiningCap(4), text, [7, 40, 61]), capCombining(text, 4));
});
