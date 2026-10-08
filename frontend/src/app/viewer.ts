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

// The read-only file viewer: one Monaco editor that never edits, with "open in editor" at the
// cursor's line (or the top of the view), and the file's diff when it has changes.

import { languageFor, monaco } from '../monaco';
import { basename, fill, h } from './dom';
import type { FileContent } from './model';
import type { Reveal } from './search';
import type { Navigator } from './navigate';
import { type Editors, spotIn } from './editors';
import { ChangeMarkers } from './changes';
import { iconButton } from './icons';
import { mediaType } from './media';
import { type MediaView, mediaView } from './mediaview';

export class Viewer {
  readonly el = h('section', { class: 'diff' });
  private header = h('header', { class: 'diff-header' });
  private actions = h('div', { class: 'diff-actions' });
  private notice = h('div', { class: 'diff-notice', hidden: true });
  private host = h('div', { class: 'diff-editor' });
  /** Where an image or a PDF shows instead of the editor. */
  private mediaHost = h('div', { class: 'media-host', hidden: true });
  private media: MediaView | null = null;
  private editor: monaco.editor.IStandaloneCodeEditor;
  path: string | null = null;
  private ticket = 0;
  private decorations: monaco.editor.IEditorDecorationsCollection | null = null;
  private markers: ChangeMarkers;

  constructor(
    private read: (path: string, raw?: boolean) => Promise<FileContent>,
    private editors: Editors,
    private relative: (path: string) => string,
    /** The file at the last commit ('' if it's new), or null if it has no changes to mark. */
    private baseline: (path: string) => Promise<string | null>,
    /** What opens a changed file's diff; null if it has none to show. */
    private diffOf: (path: string) => (() => void) | null,
  ) {
    this.el.append(this.header, this.notice, this.host, this.mediaHost);
    this.editor = monaco.editor.create(this.host, {
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      theme: 'vs-dark',
      fontSize: 12,
      scrollBeyondLastLine: false,
      // Room in the gutter for the change markers, as in VS Code.
      lineDecorationsWidth: 12,
    });
    this.markers = new ChangeMarkers(this.editor);
  }

  /** Marks the open file's changes again (its repo's status changed). */
  refreshMarkers(): void {
    const path = this.path;
    if (!path) return;
    this.renderActions();
    if (mediaType(path)) return;
    this.baseline(path).then((before) => { if (this.path === path) this.markers.show(before); }).catch(() => this.markers.clear());
  }

  /** Shows a file: at `reveal` if given, else where `saved` left it (a tab shown again). */
  async show(path: string, keepView = false, reveal?: Reveal, saved?: unknown): Promise<void> {
    const ticket = ++this.ticket;
    const same = keepView && this.path === path;
    this.path = path;
    const rel = this.relative(path);
    const name = basename(rel);
    this.header.replaceChildren(
      h('div', { class: 'diff-title', 'data-tip': path }, h('span', { class: 'dim' }, rel.slice(0, rel.length - name.length)), h('span', { class: 'diff-name' }, name)),
      this.actions,
    );
    this.renderActions();
    const type = mediaType(path);
    const content = await this.read(path, !!type);
    if (ticket !== this.ticket) return;
    this.media?.dispose();
    this.media = null;
    this.host.hidden = !!type;
    this.mediaHost.hidden = !type;
    if (type) {
      // An image or a PDF: shown as it is, with nothing for the editor to hold.
      this.notice.hidden = true;
      this.media = mediaView(content, type);
      this.mediaHost.replaceChildren(this.media.el);
      const previous = this.editor.getModel();
      this.editor.setModel(monaco.editor.createModel('', 'plaintext'));
      previous?.dispose();
      this.decorations?.clear();
      this.markers.clear();
      return;
    }
    this.mediaHost.replaceChildren();
    const notes = [
      content.binary ? `A binary file (${content.size.toLocaleString()} bytes).` : '',
      content.truncated ? 'Cut off at 50 MB.' : '',
    ].filter(Boolean);
    this.notice.textContent = notes.join(' ');
    this.notice.hidden = notes.length === 0;
    const view = same ? this.editor.saveViewState() : (saved as monaco.editor.ICodeEditorViewState | undefined) ?? null;
    const previous = this.editor.getModel();
    this.editor.setModel(monaco.editor.createModel(content.binary ? '' : content.text, languageFor(path)));
    previous?.dispose();
    if (view) this.editor.restoreViewState(view);
    if (!content.binary) this.refreshMarkers();
    this.decorations?.clear();
    if (reveal) {
      // Columns count UTF-16 units from the line's start, as Monaco does; if the file changed since
      // the search and they no longer fit, only the line is shown.
      const line = this.editor.getModel()!.getLineContent(reveal.line);
      const ranges = reveal.columns.map(([s, e]) => new monaco.Range(reveal.line, s + 1, reveal.line, e + 1));
      const fixed = ranges.every((r) => r.endColumn <= line.length + 1) ? ranges : [];
      this.decorations = this.editor.createDecorationsCollection(fixed.map((range) => ({ range, options: { inlineClassName: 'search-hit' } })));
      this.editor.revealLineInCenter(reveal.line);
      this.editor.setPosition({ lineNumber: reveal.line, column: fixed[0]?.startColumn ?? reveal.column ?? 1 });
      this.editor.focus();
    }
  }

  /** Show diff (when the file has changes) and open in the editor. */
  private renderActions(): void {
    const diff = this.path ? this.diffOf(this.path) : null;
    fill(this.actions,
      diff ? iconButton('diff', 'Show diff', diff, { class: 'framed' }) : null,
      this.editors.button(() => (this.path ? spotIn(this.editor, this.path) : null)));
  }

  saveView(): unknown {
    return this.path ? this.editor.saveViewState() : null;
  }

  attachNavigation(nav: Navigator): void {
    nav.attach(this.editor, () => this.path);
  }
}
