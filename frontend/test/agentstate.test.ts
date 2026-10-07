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

import { Notifications, readTitle, titleHasState, titleTopic } from '../src/app/agentstate.ts';

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

test('notifications: OSC 9, 777 and kitty 99, and the 99 query', () => {
  const n = new Notifications();
  assert.deepEqual(n.handle(9, 'Codex wants to run a command'), { notice: 'Codex wants to run a command' });
  assert.equal(n.handle(9, '4;1;50'), null);
  assert.deepEqual(n.handle(777, 'notify;Claude;Needs permission'), { notice: 'Claude: Needs permission' });
  // OpenCode's query, as recorded.
  assert.deepEqual(n.handle(99, 'i=opentui-notifications:p=?;'),
    { reply: '\x1b]99;i=opentui-notifications:p=?;p=title,body:o=always,unfocused:u=0,1,2\x1b\\' });
  assert.deepEqual(n.handle(99, ';Hello world'), { notice: 'Hello world' });
  assert.equal(n.handle(99, 'i=1:d=0;Permission required'), null);
  assert.deepEqual(n.handle(99, 'i=1:p=body;Write ../x.txt'), { notice: 'Permission required: Write ../x.txt' });
  assert.deepEqual(n.handle(99, `i=2:e=1;${btoa('Done')}`), { notice: 'Done' });
});
