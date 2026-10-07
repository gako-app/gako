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
import fs from 'node:fs';

import { parseLicence, parseNotices } from '../src/about/legal.ts';

const root = new URL('../../', import.meta.url);
const read = (name: string) => fs.readFileSync(new URL(name, root), 'utf8');

test('the licence splits into its title, headings, 18 sections and lettered items', () => {
  const blocks = parseLicence(read('LICENSE'));
  assert.deepEqual(blocks[0], { kind: 'title', lines: ['GNU AFFERO GENERAL PUBLIC LICENSE', 'Version 3, 19 November 2007'] });
  assert.equal(blocks[1].kind, 'lines');
  const headings = blocks.flatMap((b) => (b.kind === 'heading' ? [b.text] : []));
  assert.deepEqual(headings, ['Preamble', 'TERMS AND CONDITIONS', 'END OF TERMS AND CONDITIONS', 'How to Apply These Terms to Your New Programs']);
  const sections = blocks.flatMap((b) => (b.kind === 'section' ? [`${b.number}. ${b.title}`] : []));
  assert.equal(sections.length, 18);
  assert.equal(sections[0], '0. Definitions');
  assert.equal(sections[13], '13. Remote Network Interaction; Use with the GNU General Public License');
  const items = blocks.filter((b) => b.kind === 'item');
  assert.equal(items.length, 4 + 5 + 6); // sections 5, 6 and 7
  // The sample notice keeps its lines; paragraphs are joined.
  const sample = blocks.find((b) => b.kind === 'lines' && b.lines[0].startsWith('<one line'));
  assert.ok(sample);
  assert.ok(blocks.every((b) => b.kind !== 'para' || !b.text.includes('\n')));
});

test('the notices list every package, with each shared text filled in', () => {
  const pkgs = parseNotices(read('THIRD-PARTY-NOTICES.txt'));
  const header = read('THIRD-PARTY-NOTICES.txt').match(/(\d+) npm packages .* and (\d+) Rust crates/)!;
  assert.equal(pkgs.filter((p) => p.group === 'npm packages').length, Number(header[1]));
  assert.equal(pkgs.filter((p) => p.group === 'Rust crates').length, Number(header[2]));
  const xterm = pkgs.find((p) => p.name === '@xterm/xterm')!;
  assert.equal(xterm.licence, 'MIT');
  assert.match(xterm.source ?? '', /^https?:/);
  for (const p of pkgs) {
    assert.ok(p.name && p.version && p.licence, `${p.name} ${p.version}`);
    for (const t of p.texts) assert.ok(t.text.trim(), `${p.name}: ${t.file} is empty`);
  }
  assert.ok(pkgs.some((p) => p.texts.some((t) => t.sameAs)));
});
