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

import { arrange, worktreeName, type FamilyRepo, type Placed } from '../src/app/worktrees.ts';

interface R extends FamilyRepo { changed: boolean }

/** `spec`: space-separated roots; `*` marks a changed one, `<main` a worktree of `main`. */
function repos(spec: string): R[] {
  return spec.split(' ').map((s) => {
    const changed = s.includes('*');
    const [root, main] = s.replace('*', '').split('<');
    return { root, kind: main ? 'worktree' : 'normal', main, changed };
  });
}

const show = (list: Placed<R>[]) => list.map((p) =>
  `${p.nested ? '  ' : ''}${p.repo.root}${p.parentOnly ? ' (header)' : ''}${p.apart ? ' (apart)' : ''}`);

const run = (spec: string, cleanWorktrees = true) =>
  arrange(repos(spec), (r) => r.changed, () => true, cleanWorktrees);

test('a changed worktree brings its clean main repo along, as a header', () => {
  const { changed, clean } = run('/a /b /x/wt1*</a /x/wt2</a');
  assert.deepEqual(show(changed), ['/a (header)', '  /x/wt1']);
  assert.deepEqual(show(clean), ['/x/wt2 (apart)', '/b']);
});

test('a clean family stays together in the clean group', () => {
  const { changed, clean } = run('/a* /b /x/wt</b');
  assert.deepEqual(show(changed), ['/a']);
  assert.deepEqual(show(clean), ['/b', '  /x/wt']);
});

test('a changed main repo keeps its changed worktrees under it', () => {
  const { changed, clean } = run('/a* /x/one*</a /x/two</a');
  assert.deepEqual(show(changed), ['/a', '  /x/one']);
  assert.deepEqual(show(clean), ['/x/two (apart)']);
});

test('clean worktrees can be left out', () => {
  const { changed, clean } = run('/a /b* /x/one</a /x/two*</a /y/in</b', false);
  assert.deepEqual(show(changed), ['/a (header)', '  /x/two', '/b']);
  assert.deepEqual(show(clean), []);
});

test('a worktree whose main repo isn\'t listed stands alone', () => {
  const { changed, clean } = run('/a /wt*</elsewhere');
  assert.deepEqual(show(changed), ['/wt']);
  assert.deepEqual(show(clean), ['/a']);
});

test('a worktree is named by its folder, or two parts when that repeats the main repo\'s', () => {
  assert.equal(worktreeName('/base/app-feature', '/base/app'), 'app-feature');
  assert.equal(worktreeName('/home/u/.codex/worktrees/a1b2/app', '/base/app'), 'a1b2/app');
  assert.equal(worktreeName('C:\\wt\\a1b2\\app', 'C:\\base\\app'), 'a1b2/app');
});
