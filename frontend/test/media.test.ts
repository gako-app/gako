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

import { byteSize, mediaType } from '../src/app/media.ts';

test('images and PDFs are known by extension, in any case; everything else is text', () => {
  assert.equal(mediaType('docs/logo.PNG')?.mime, 'image/png');
  assert.equal(mediaType('a/b/photo.jpeg')?.kind, 'image');
  assert.equal(mediaType('C:\\work\\spec.pdf')?.kind, 'pdf');
  assert.equal(mediaType('icon.svg'), null);
  assert.equal(mediaType('README'), null);
  assert.equal(mediaType('.png'), null);
  assert.equal(mediaType('archive.png.txt'), null);
});

test('sizes read naturally', () => {
  assert.equal(byteSize(1), '1 byte');
  assert.equal(byteSize(912), '912 bytes');
  assert.equal(byteSize(252_374), '246 KB');
  assert.equal(byteSize(3_250_000), '3.1 MB');
});
