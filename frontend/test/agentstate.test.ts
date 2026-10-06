import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readTitle, titleHasState, titleTopic } from '../src/app/agentstate.ts';

// Titles as recorded from the agents on 2026-10-06.
test('Claude Code: quarter circles while working, a star otherwise', () => {
  assert.equal(readTitle('◐ Claude Code'), 'working');
  assert.equal(readTitle('◑ Reply with hi'), 'working');
  assert.equal(readTitle('✳ Reply with hi'), 'idle');
  assert.ok(titleHasState('✳ Reply with hi'));
  assert.equal(titleTopic('◑ Reply with hi'), 'Reply with hi');
});

test('Codex: braille while working, Action Required while waiting', () => {
  assert.equal(readTitle('⠦ Reply hi | agents-trial'), 'working');
  assert.equal(readTitle('⠏ ⠏ | agents-trial'), 'working');
  assert.equal(readTitle('[ ! ] Action Required | Reply hi | agents-trial'), 'waiting');
  assert.equal(readTitle('[ . ] Action Required | Reply hi | agents-trial'), 'waiting');
  assert.equal(readTitle('Reply hi | agents-trial'), 'idle');
  assert.equal(titleTopic('[ ! ] Action Required | Reply hi | agents-trial'), 'Reply hi | agents-trial');
  assert.equal(titleTopic('⠏ ⠏ | agents-trial'), 'agents-trial');
});

test('fixed titles say nothing', () => {
  assert.equal(readTitle('OC | Greeting request'), 'idle');
  assert.equal(titleHasState('OC | Greeting request'), false);
  assert.equal(titleHasState('π - agents-trial'), false);
  assert.equal(titleHasState(''), false);
});
