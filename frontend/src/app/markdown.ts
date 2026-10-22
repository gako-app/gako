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

// Markdown files, rendered for reading (mdview.ts shows them): the HTML markdown-it makes of them,
// with every block marked with the source lines it came from, so the changes since the last commit
// can be marked on the blocks they touch; and where the links in them lead. Nothing here touches
// the DOM: what's made is cleaned before it's shown. markdown-it loads with the first file
// rendered, so the window doesn't carry it until then.

import type MarkdownIt from 'markdown-it';

const EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);

/** Whether a path is a Markdown file, by its extension. */
export function isMarkdown(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

let engine: Promise<MarkdownIt> | null = null;

/** The HTML of a Markdown file, not yet cleaned. */
export async function renderMarkdown(text: string): Promise<string> {
  engine ??= import('markdown-it').then(({ default: MarkdownIt }) => setUp(new MarkdownIt({ html: true, linkify: true })));
  return (await engine).render(text);
}

/** CommonMark with GitHub's tables and strikethrough, web addresses made links, and HTML allowed in
 * it (READMEs use <details>, <br> and <img>), which mdview.ts cleans. */
function setUp(md: MarkdownIt): MarkdownIt {
  // Each block's first and last source line (1-based, inclusive).
  md.core.ruler.push('source_lines', (state) => {
    for (const t of state.tokens) {
      if (t.map && t.nesting !== -1) {
        t.attrSet('data-line', String(t.map[0] + 1));
        t.attrSet('data-line-end', String(t.map[1]));
      }
    }
  });
  // Code blocks name their language in an attribute rather than a class: classes are taken out, so
  // a file can't borrow the app's own.
  md.renderer.rules.fence = (tokens, i) => {
    const t = tokens[i];
    const lang = t.info.trim().split(/\s+/)[0] ?? '';
    const attrs = `data-line="${t.attrGet('data-line')}" data-line-end="${t.attrGet('data-line-end')}"`;
    const code = md.utils.escapeHtml(t.content);
    return `<pre ${attrs}><code${lang ? ` data-lang="${md.utils.escapeHtml(lang)}"` : ''}>${code}</code></pre>\n`;
  };
  return md;
}

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces as hyphens. Repeats
 * are numbered by `seen`, as GitHub does: intro, intro-1, intro-2. */
export function slug(text: string, seen: Map<string, number>): string {
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

export type Target =
  | { kind: 'anchor'; id: string }
  | { kind: 'web'; url: string }
  | { kind: 'file'; path: string; id: string };

/** Where a link in the file at `from` leads: a heading in it, a web page, or another file (relative
 * to the file, or to `root`, its repository, when it starts with /). Null for anything else
 * (mailto:, javascript:…). */
export function linkTarget(href: string, from: string, root: string | null): Target | null {
  if (href.startsWith('#')) return { kind: 'anchor', id: decode(href.slice(1)) };
  if (/^https?:\/\//i.test(href)) return { kind: 'web', url: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const hash = href.indexOf('#');
  const rel = decode((hash < 0 ? href : href.slice(0, hash)).split('?')[0]);
  const id = hash < 0 ? '' : decode(href.slice(hash + 1));
  if (!rel) return { kind: 'anchor', id };
  return { kind: 'file', path: resolvePath(from, rel, root), id };
}

/** A path `rel` (with / between its parts) seen from the file at `from`, in `from`'s own form
 * (with \ on Windows). One starting with / is from `root`, if known. */
export function resolvePath(from: string, rel: string, root: string | null): string {
  const sep = from.includes('\\') && !from.includes('/') ? '\\' : '/';
  const start = rel.startsWith('/') && root ? root : from.slice(0, Math.max(from.lastIndexOf('/'), from.lastIndexOf('\\')));
  const parts = start.split(/[\\/]/);
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue;
    // Never above the first part: / on Unix, the drive on Windows.
    if (p === '..') { if (parts.length > 1) parts.pop(); } else parts.push(p);
  }
  return parts.join(sep);
}

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export type ChangeKind = 'added' | 'modified' | 'deleted';

/** A change since the last commit, in lines of the file now, as ChangeMarkers works them out: for a
 * deletion, `start` is the line it follows (0 at the very top). */
export interface LineChange {
  kind: ChangeKind;
  start: number;
  end: number;
}

/** A rendered block, by its source lines (1-based, inclusive). */
export interface Block {
  start: number;
  end: number;
}

export interface BlockMark {
  /** Index into the blocks. */
  block: number;
  kind: ChangeKind;
  /** The change's line, as ChangeMarkers finds it: its first line in the block, or the line a
   * deletion follows. */
  line: number;
  /** For a deletion: whether it was above the block (at the very top) rather than below it. */
  above?: boolean;
}

/** Which blocks show which change: every block with lines added or changed (added if all its lines
 * are new, else modified), and, for each deletion, the last block before it (or the first, for one
 * at the very top). `blocks` should be the innermost ones only: none holding another. */
export function markBlocks(blocks: Block[], changes: LineChange[]): BlockMark[] {
  const marks: BlockMark[] = [];
  blocks.forEach((b, i) => {
    let added = 0;
    let modified = false;
    let line = 0;
    for (const c of changes) {
      if (c.kind === 'deleted' || c.start > b.end || c.end < b.start) continue;
      line ||= Math.max(c.start, b.start);
      if (c.kind === 'modified') modified = true;
      else added += Math.min(c.end, b.end) - Math.max(c.start, b.start) + 1;
    }
    if (line) marks.push({ block: i, kind: !modified && added === b.end - b.start + 1 ? 'added' : 'modified', line });
  });
  for (const c of changes) {
    if (c.kind !== 'deleted' || !blocks.length) continue;
    const at = blocks.findLastIndex((b) => b.start <= c.start);
    marks.push(at < 0 ? { block: 0, kind: 'deleted', line: c.start, above: true } : { block: at, kind: 'deleted', line: c.start });
  }
  return marks;
}
