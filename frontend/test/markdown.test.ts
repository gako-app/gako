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

import { isMarkdown, linkTarget, markBlocks, renderMarkdown, resolvePath, slug } from '../src/app/markdown.ts';

test('Markdown files are known by extension, in any case', () => {
  assert.ok(isMarkdown('docs/README.md'));
  assert.ok(isMarkdown('C:\\work\\NOTES.Markdown'));
  assert.ok(!isMarkdown('README'));
  assert.ok(!isMarkdown('.md'));
  assert.ok(!isMarkdown('page.mdx'));
});

test('every block carries its source lines, and code its language in an attribute', async () => {
  const html = await renderMarkdown('# Title\n\nSome text\nover two lines.\n\n```ts\nconst a = 1;\n```\n');
  assert.match(html, /<h1 data-line="1" data-line-end="1">Title<\/h1>/);
  assert.match(html, /<p data-line="3" data-line-end="4">/);
  assert.match(html, /<pre data-line="6" data-line-end="8"><code data-lang="ts">const a = 1;\n<\/code><\/pre>/);
  assert.doesNotMatch(await renderMarkdown('```"><script>\nx\n```'), /<script>/);
});

test('headings get the anchors GitHub gives them', () => {
  const seen = new Map<string, number>();
  assert.equal(slug('Getting Started!', seen), 'getting-started');
  assert.equal(slug('Getting started', seen), 'getting-started-1');
  assert.equal(slug('API: `fileRead` & co.', seen), 'api-fileread--co');
  assert.equal(slug('Déjà vu', seen), 'déjà-vu');
});

test('links lead to headings, web pages or files, and nowhere else', () => {
  assert.deepEqual(linkTarget('#usage', '/r/README.md', '/r'), { kind: 'anchor', id: 'usage' });
  assert.deepEqual(linkTarget('https://gako.app', '/r/README.md', '/r'), { kind: 'web', url: 'https://gako.app' });
  assert.deepEqual(linkTarget('docs/a%20b.md#x', '/r/README.md', '/r'), { kind: 'file', path: '/r/docs/a b.md', id: 'x' });
  assert.deepEqual(linkTarget('/docs/scope.md', '/r/docs/x/y.md', '/r'), { kind: 'file', path: '/r/docs/scope.md', id: '' });
  assert.equal(linkTarget('javascript:alert(1)', '/r/README.md', '/r'), null);
  assert.equal(linkTarget('mailto:a@b.c', '/r/README.md', '/r'), null);
  assert.equal(linkTarget('//evil.example/x', '/r/README.md', '/r'), null);
});

test('paths resolve in the file\'s own form, never above its root', () => {
  assert.equal(resolvePath('/r/docs/a.md', '../img/x.png', null), '/r/img/x.png');
  assert.equal(resolvePath('/r/a.md', '../../../x', null), '/x');
  assert.equal(resolvePath('C:\\r\\docs\\a.md', './b/c.md', null), 'C:\\r\\docs\\b\\c.md');
  assert.equal(resolvePath('C:\\r\\a.md', '../../..', null), 'C:');
});

test('changes mark the innermost blocks they touch', () => {
  const blocks = [{ start: 1, end: 1 }, { start: 3, end: 5 }, { start: 7, end: 9 }];
  // Lines added inside a paragraph that was there: the paragraph changed.
  assert.deepEqual(markBlocks(blocks, [{ kind: 'added', start: 4, end: 4 }]), [{ block: 1, kind: 'modified', line: 4 }]);
  // A whole new block.
  assert.deepEqual(markBlocks(blocks, [{ kind: 'added', start: 6, end: 9 }]), [{ block: 2, kind: 'added', line: 7 }]);
  assert.deepEqual(markBlocks(blocks, [{ kind: 'modified', start: 1, end: 3 }]),
    [{ block: 0, kind: 'modified', line: 1 }, { block: 1, kind: 'modified', line: 3 }]);
  // Deletions: after the last block before them, or above the first.
  assert.deepEqual(markBlocks(blocks, [{ kind: 'deleted', start: 6, end: 6 }]), [{ block: 1, kind: 'deleted', line: 6 }]);
  assert.deepEqual(markBlocks(blocks, [{ kind: 'deleted', start: 0, end: 0 }]), [{ block: 0, kind: 'deleted', line: 0, above: true }]);
  assert.deepEqual(markBlocks(blocks, []), []);
});
