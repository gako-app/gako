import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CombiningCap, capCombining } from '../src/combining.ts';

const enc = new TextEncoder();
const marks = (n: number) => '́'.repeat(n);

test('caps a run within one chunk', () => {
  const c = new CombiningCap(8);
  assert.equal(c.apply(enc.encode(`a${marks(20)}b${marks(3)}`)), `a${marks(8)}b${marks(3)}`);
});

test('counts a run across chunks, including a chunk of marks only', () => {
  const c = new CombiningCap(8);
  const out = c.apply(enc.encode(`x a${marks(5)}`)) + c.apply(enc.encode(marks(2))) + c.apply(enc.encode(`${marks(6)}b`));
  assert.equal(out, `x a${marks(8)}b`);
});

test('a UTF-8 sequence split between chunks survives', () => {
  const c = new CombiningCap(8);
  const bytes = enc.encode('é→日本');
  assert.equal(c.apply(bytes.slice(0, 3)) + c.apply(bytes.slice(3)), 'é→日本');
});

test('capCombining matches the streaming cap', () => {
  const text = `q${marks(30)} r${marks(9)} s${marks(1)}`;
  const c = new CombiningCap(8);
  const b = enc.encode(text);
  const streamed = c.apply(b.slice(0, 17)) + c.apply(b.slice(17, 40)) + c.apply(b.slice(40));
  assert.equal(streamed, capCombining(text, 8));
});
