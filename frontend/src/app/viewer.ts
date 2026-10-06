// The read-only file viewer: one Monaco editor that never edits, with "open in editor" at the
// cursor's line (or the top of the view).

import { languageFor, monaco } from '../monaco';
import { basename, h } from './dom';
import type { FileContent } from './model';
import type { Reveal } from './search';
import type { Navigator } from './navigate';
import { type Editors, spotIn } from './editors';
import { ChangeMarkers } from './changes';

export class Viewer {
  readonly el = h('section', { class: 'diff' });
  private header = h('header', { class: 'diff-header' });
  private notice = h('div', { class: 'diff-notice', hidden: true });
  private host = h('div', { class: 'diff-editor' });
  private editor: monaco.editor.IStandaloneCodeEditor;
  path: string | null = null;
  private ticket = 0;
  private decorations: monaco.editor.IEditorDecorationsCollection | null = null;
  private markers: ChangeMarkers;

  constructor(
    private read: (path: string) => Promise<FileContent>,
    private editors: Editors,
    private relative: (path: string) => string,
    /** The file at the last commit ('' if it's new), or null if it has no changes to mark. */
    private baseline: (path: string) => Promise<string | null>,
  ) {
    this.el.append(this.header, this.notice, this.host);
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
    this.baseline(path).then((before) => { if (this.path === path) this.markers.show(before); }).catch(() => this.markers.clear());
  }

  /** Shows a file: at `reveal` if given, else where `saved` left it (a tab shown again). */
  async show(path: string, keepView = false, reveal?: Reveal, saved?: unknown): Promise<void> {
    const ticket = ++this.ticket;
    const same = keepView && this.path === path;
    this.path = path;
    this.header.replaceChildren(
      h('div', { class: 'diff-title' }, h('span', { class: 'diff-name' }, basename(path)), h('span', { class: 'dim' }, ` ${this.relative(path)}`)),
      h('div', { class: 'diff-actions' }, this.editors.button(() => (this.path ? spotIn(this.editor, this.path) : null))),
    );
    const content = await this.read(path);
    if (ticket !== this.ticket) return;
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

  saveView(): unknown {
    return this.path ? this.editor.saveViewState() : null;
  }

  attachNavigation(nav: Navigator): void {
    nav.attach(this.editor, () => this.path);
  }
}
