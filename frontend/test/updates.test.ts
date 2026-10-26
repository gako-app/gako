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

import { compareVersions } from '../src/app/updates.ts';

test('versions compare as semantic versions', () => {
  const older = (a: string, b: string) => {
    assert.ok(compareVersions(a, b)! < 0, `${a} < ${b}`);
    assert.ok(compareVersions(b, a)! > 0, `${b} > ${a}`);
  };
  older('0.23.0', '0.24.0');
  older('0.9.0', '0.10.0');
  older('0.23.9', '1.0.0');
  older('0.23.0-beta.2', '0.23.0');
  older('0.23.0-beta.2', '0.23.0-beta.10');
  older('0.23.0-beta', '0.23.0-beta.1');
  older('0.23.0-1', '0.23.0-beta');
  older('0.23.0-alpha.1', '0.23.0-beta.1');
  assert.equal(compareVersions('v0.23.0', '0.23.0'), 0);
  assert.equal(compareVersions('0.23.0+build.5', '0.23.0'), 0);
  assert.equal(compareVersions('0.23', '0.23.0'), null);
  assert.equal(compareVersions('latest', '0.23.0'), null);
});
