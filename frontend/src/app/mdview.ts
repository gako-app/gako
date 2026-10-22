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

// A Markdown file rendered for reading, in the viewer. What markdown-it makes of it is cleaned with
// DOMPurify before it's shown: no scripts, forms, styles or classes of its own, since the file is
// anyone's. Code blocks are coloured by Monaco; links to headings, files and web pages go where
// they lead (web pages in the browser); images from the repository are read through the core, and
// images from the web aren't loaded. The changes since the last commit are marked beside the
// blocks they touch, as the source's gutter marks lines, and a click on a mark shows the change in
// the source. DOMPurify, like markdown-it, loads with the first file rendered.

import type { Config } from 'dompurify';
import { languageNamed, monaco } from '../monaco';
import { delay, h } from './dom';
import { type Block, type LineChange, linkTarget, markBlocks, renderMarkdown, slug } from './markdown';
import { mediaType } from './media';
import type { FileContent } from './model';

export interface MarkdownHooks {
  /** A file's bytes (base64), for the images in it. */
  read(path: string): Promise<FileContent>;
  /** Opens another file, at a heading in it if `id` isn't ''. */
  open(path: string, id: string): void;
  /** The repository a file is in, for links starting with /. */
  rootOf(path: string): string | null;
  /** A change mark clicked: the change at this line, in the source. */
  showChange(line: number): void;
}

/** A block, its own source lines, and where its own part ends: at its first block inside, if it
 * holds any (a list item with a list in it), else at its own end. */
interface Shown extends Block {
  el: HTMLElement;
  until: HTMLElement | null;
}

const CLEAN: Config & { RETURN_DOM_FRAGMENT: true } = {
  RETURN_DOM_FRAGMENT: true,
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'dialog', 'video', 'audio', 'source', 'track'],
  FORBID_ATTR: ['style', 'class', 'id', 'srcset'],
};

export class MarkdownView {
  readonly el = h('div', { class: 'md-view' });
  private gutter = h('div', { class: 'md-gutter' });
  private body = h('article', { class: 'md-body' });
  private path = '';
  private changes: LineChange[] = [];
  private ticket = 0;

  constructor(private hooks: MarkdownHooks) {
    this.el.append(this.gutter, this.body);
    this.body.addEventListener('click', (e) => this.click(e));
    // Images loading, code coloured or the view resized: the marks move with their blocks.
    new ResizeObserver(() => this.drawMarks()).observe(this.body);
  }

  /** Renders `text`, the file at `path`. Resolves once it's ready to be seen, its code coloured
   * (unless that takes long); the images in it come as they load. */
  async render(text: string, path: string): Promise<void> {
    const ticket = ++this.ticket;
    this.path = path;
    const [html, { default: DOMPurify }] = await Promise.all([renderMarkdown(text), import('dompurify')]);
    if (ticket !== this.ticket) return;
    const doc = DOMPurify.sanitize(html, CLEAN);
    const seen = new Map<string, number>();
    for (const el of doc.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) el.dataset.anchor = slug(el.textContent ?? '', seen);
    for (const li of doc.querySelectorAll('li')) taskItem(li);
    for (const img of doc.querySelectorAll('img')) this.image(img);
    const coloured = [...doc.querySelectorAll<HTMLElement>('pre > code[data-lang]')].map(async (code) => {
      const lang = languageNamed(code.dataset.lang!);
      if (!lang) return;
      const html = await monaco.editor.colorize((code.textContent ?? '').replace(/\r?\n$/, ''), lang, { tabSize: 4 });
      // Monaco ends every line with a break, the last one included, which would show as an empty line.
      if (ticket === this.ticket) code.innerHTML = html.replace(/<br\/?>\s*$/, '');
    });
    await Promise.race([Promise.all(coloured), delay(150)]);
    if (ticket !== this.ticket) return;
    this.body.replaceChildren(doc);
    this.drawMarks();
  }

  /** Marks these changes (none: no marks). */
  mark(changes: LineChange[]): void {
    this.changes = changes;
    this.drawMarks();
  }

  /** The source line of the first block in view, for showing the source at the same place. */
  topLine(): number {
    const top = this.el.getBoundingClientRect().top;
    for (const el of this.body.querySelectorAll<HTMLElement>('[data-line]')) {
      if (el.getBoundingClientRect().bottom > top) return Number(el.dataset.line);
    }
    return 1;
  }

  /** Scrolls to the last block starting at or before `line`. */
  scrollToLine(line: number): void {
    let at: HTMLElement | null = null;
    for (const el of this.body.querySelectorAll<HTMLElement>('[data-line]')) {
      if (Number(el.dataset.line) > line) break;
      at = el;
    }
    this.el.scrollTop = at && line > 1 ? this.offset(at) - 8 : 0;
  }

  get scroll(): number {
    return this.el.scrollTop;
  }

  set scroll(top: number) {
    this.el.scrollTop = top;
  }

  /** Scrolls to a heading (or an <a name>); false if there's none by that name. */
  reveal(id: string): boolean {
    if (!id) return false;
    const q = CSS.escape(id);
    const el = this.body.querySelector<HTMLElement>(`[data-anchor="${q}"], a[name="${q}"]`)
      ?? this.body.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(id.toLowerCase())}"]`);
    if (el) this.el.scrollTop = this.offset(el) - 8;
    return !!el;
  }

  /** An element's top, in the view's scrolled content. */
  private offset(el: HTMLElement): number {
    return el.getBoundingClientRect().top - this.el.getBoundingClientRect().top + this.el.scrollTop;
  }

  /** An image from the repository, read and inlined; one from the web, left out and named. */
  private image(img: HTMLImageElement): void {
    const src = img.getAttribute('src') ?? '';
    // Never loaded from where it says: a relative one would come from the app's own files.
    if (src.startsWith('data:image/')) return;
    img.removeAttribute('src');
    const target = linkTarget(src, this.path, this.hooks.rootOf(this.path));
    if (target?.kind !== 'file') {
      const what = img.alt || (target?.kind === 'web' ? target.url.replace(/^https?:\/\/([^/]*).*$/i, '$1') : 'image');
      img.replaceWith(h('span', { class: 'md-no-image', 'data-tip': src ? `Images from the web aren't loaded:\n${src}` : 'No image' }, what));
      return;
    }
    const path = target.path;
    const svg = /\.svg$/i.test(path);
    const mime = svg ? 'image/svg+xml' : mediaType(path)?.kind === 'image' ? mediaType(path)!.mime : null;
    if (!mime) return;
    const ticket = this.ticket;
    this.hooks.read(path).then((c) => {
      if (ticket === this.ticket && c.base64) img.src = `data:${mime};base64,${c.base64}`;
    }).catch(() => {});
  }

  private click(e: MouseEvent): void {
    const a = (e.target as Element).closest?.('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    const target = href ? linkTarget(href, this.path, this.hooks.rootOf(this.path)) : null;
    if (!target) return;
    if (target.kind === 'anchor') this.reveal(target.id);
    // The shell opens web pages in the browser, never in the app.
    else if (target.kind === 'web') window.open(target.url, '_blank');
    else if (target.path === this.path) this.reveal(target.id);
    else this.hooks.open(target.path, target.id);
  }

  /** The blocks to mark: each with source lines of its own, which a list or a quote holding only
   * other blocks doesn't have. */
  private blocks(): Shown[] {
    const out: Shown[] = [];
    for (const el of this.body.querySelectorAll<HTMLElement>('[data-line]')) {
      const start = Number(el.dataset.line);
      const inner = el.querySelector<HTMLElement>('[data-line]');
      const end = inner ? Number(inner.dataset.line) - 1 : Number(el.dataset.lineEnd);
      if (end >= start) out.push({ start, end, el, until: inner });
    }
    return out;
  }

  private drawMarks(): void {
    for (const el of this.body.querySelectorAll('.md-changed')) el.classList.remove('md-changed', 'added', 'modified');
    if (!this.changes.length) {
      this.gutter.replaceChildren();
      return;
    }
    const blocks = this.blocks();
    const marks = markBlocks(blocks, this.changes);
    this.gutter.replaceChildren(...marks.map((m) => {
      const b = blocks[m.block];
      const top = this.offset(b.el);
      const bottom = b.until ? this.offset(b.until) : top + b.el.getBoundingClientRect().height;
      if (m.kind === 'deleted') {
        const at = m.above ? top : bottom;
        return this.marker('deleted', at, 0, m.line, 'Click to see what was deleted');
      }
      if (!b.until) b.el.classList.add('md-changed', m.kind);
      return this.marker(m.kind, top, bottom - top, m.line, 'Click to see what changed');
    }));
  }

  private marker(kind: string, top: number, height: number, line: number, tip: string): HTMLElement {
    return h('div', {
      class: `md-mark ${kind}`, style: `top:${top}px;height:${height}px`, 'data-tip': tip,
      onclick: () => this.hooks.showChange(Math.max(1, line)),
    });
  }
}

/** A list item starting [ ] or [x], as GitHub shows it: with a checkbox, ticked or not. */
function taskItem(li: HTMLLIElement): void {
  const holder = li.firstElementChild instanceof HTMLParagraphElement && !li.firstChild?.textContent?.trim() ? li.firstElementChild : li;
  const text = [...holder.childNodes].find((n) => n.nodeType !== Node.TEXT_NODE || n.textContent!.trim());
  if (!(text instanceof Text)) return;
  const m = /^\s*\[([ xX])\]\s/.exec(text.data);
  if (!m) return;
  text.data = text.data.slice(m[0].length);
  li.classList.add('md-task');
  holder.insertBefore(h('input', { type: 'checkbox', disabled: true, checked: m[1] !== ' ', tabindex: -1 }), text);
}
