// The diff panel: Monaco's diff editor, read-only, with a header for what's shown and what can be
// done with it. When the file changes on disk while it's open, the diff updates in place.

import { languageFor, monaco } from '../monaco';
import { basename, dirname, fill, h } from './dom';
import type { DiffTarget, FileContent, Side } from './model';
import type { Git } from './git';
import type { Navigator } from './navigate';
import { type Editors, type Spot, spotIn } from './editors';

const INLINE = 'gako.diffInline';

const KIND_LABEL: Record<DiffTarget['kind'], string> = {
  unstaged: 'Index ↔ working tree',
  staged: 'HEAD ↔ index (staged)',
  review: 'HEAD ↔ working tree',
  conflict: 'HEAD ↔ working tree (conflict)',
  commit: 'Commit',
};

export interface DiffActions {
  prev?: () => void;
  next?: () => void;
  stage?: () => void;
  unstage?: () => void;
  back?: () => void;
  /** The working-tree file shown on the right, which can be opened in the viewer or an editor. */
  file?: string;
  repoName: string;
}

export class DiffPanel {
  readonly el = h('section', { class: 'diff' });
  private header = h('header', { class: 'diff-header' });
  private notice = h('div', { class: 'diff-notice' });
  private host = h('div', { class: 'diff-editor' });
  private editor: monaco.editor.IStandaloneDiffEditor;
  target: DiffTarget | null = null;
  private loading = 0;
  private inline = false;

  constructor(private git: Git, private editors: Editors, private openFile: (spot: Spot) => void) {
    try { this.inline = localStorage.getItem(INLINE) === '1'; } catch { /* storage unavailable */ }
    this.el.append(this.header, this.notice, this.host);
    this.editor = monaco.editor.createDiffEditor(this.host, {
      readOnly: true,
      domReadOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: !this.inline,
      hideUnchangedRegions: { enabled: true },
      theme: 'vs-dark',
      fontSize: 12,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
  }

  private async side(repo: string, side: Side | null): Promise<FileContent | null> {
    if (!side) return null;
    return this.git.file(repo, side.rev, side.path);
  }

  /** Shows a diff. With `keepView`, the scroll position survives (a refresh of the same file); `view`
   * restores one saved earlier (a tab shown again). */
  async show(target: DiffTarget, actions: DiffActions, keepView = false, saved?: unknown): Promise<void> {
    const ticket = ++this.loading;
    const same = keepView && this.target && this.target.repo === target.repo && this.target.path === target.path &&
      this.target.kind === target.kind;
    this.target = target;
    this.renderHeader(target, actions);
    const [left, right] = await Promise.all([this.side(target.repo, target.left), this.side(target.repo, target.right)]);
    if (ticket !== this.loading) return; // a newer request won
    const notes: string[] = [];
    for (const [name, c] of [['left', left], ['right', right]] as const) {
      if (c?.binary) notes.push(`The ${name} side is a binary file (${c.size.toLocaleString()} bytes).`);
      if (c?.truncated) notes.push(`The ${name} side is cut off at 50 MB.`);
    }
    this.notice.textContent = notes.join(' ');
    this.notice.hidden = notes.length === 0;

    const lang = languageFor(target.path);
    const view = same ? this.editor.getModifiedEditor().saveViewState() : (saved as monaco.editor.ICodeEditorViewState | undefined) ?? null;
    const previous = this.editor.getModel();
    const model = {
      original: monaco.editor.createModel(left?.text ?? '', languageFor(target.left?.path ?? target.path)),
      modified: monaco.editor.createModel(right?.text ?? '', lang),
    };
    this.editor.setModel(model);
    previous?.original.dispose();
    previous?.modified.dispose();
    if (view) this.editor.getModifiedEditor().restoreViewState(view);
  }

  private renderHeader(t: DiffTarget, a: DiffActions): void {
    const renamed = t.left && t.right && t.left.path !== t.right.path ? `${t.left.path} → ` : '';
    const what = t.kind === 'commit' ? `Commit ${t.hash?.slice(0, 7)}` : KIND_LABEL[t.kind];
    const sideLabel = (s: Side | null) => (s ? (s.rev === 'worktree' ? 'working tree' : s.rev === 'index' ? 'index' : s.rev.slice(0, 7)) : '(none)');
    fill(this.header,
      a.back ? h('button', { class: 'link', onclick: a.back }, '← Back') : null,
      h('div', { class: 'diff-title' },
        h('span', { class: 'diff-name' }, basename(t.path)),
        h('span', { class: 'dim' }, ` ${a.repoName}${dirname(t.path) ? ' › ' + dirname(t.path) : ''}`),
        renamed ? h('span', { class: 'dim' }, ` (renamed from ${renamed.slice(0, -3)})`) : null),
      h('div', { class: 'diff-kind dim', title: `left: ${sideLabel(t.left)}, right: ${sideLabel(t.right)}` }, what),
      h('div', { class: 'diff-actions' },
        a.file ? h('button', { onclick: () => this.openFile(this.spot(a.file!)), title: 'Show the whole file, at this line' }, 'Open file') : null,
        a.file ? this.editors.button(() => this.spot(a.file!)) : null,
        a.stage ? h('button', { onclick: a.stage, title: 'Stage this file' }, 'Stage') : null,
        a.unstage ? h('button', { onclick: a.unstage, title: 'Unstage this file' }, 'Unstage') : null,
        this.modeSwitch(),
        h('button', { onclick: a.prev, disabled: !a.prev, title: 'Previous file (↑)' }, '↑'),
        h('button', { onclick: a.next, disabled: !a.next, title: 'Next file (↓)' }, '↓')),
    );
  }

  /** The scroll position and cursor, to restore when this diff is shown again. */
  saveView(): unknown {
    return this.target ? this.editor.getModifiedEditor().saveViewState() : null;
  }

  /** Where the right side is: the cursor's line if it's on screen, else the top of the view. */
  private spot(path: string): Spot {
    return spotIn(this.editor.getModifiedEditor(), path);
  }

  /** Side by side or inline, showing which one is on. */
  private modeSwitch(): HTMLElement {
    const option = (inline: boolean, label: string) => h('button', {
      class: inline === this.inline ? 'on' : '', 'aria-pressed': String(inline === this.inline),
      onclick: () => this.setInline(inline),
    }, label);
    return h('span', { class: 'segmented', role: 'group', title: 'How the diff is laid out' },
      option(false, 'Side by side'), option(true, 'Inline'));
  }

  /** Navigation on both sides; `abs` turns a repo-relative path into a full one. */
  attachNavigation(nav: Navigator, abs: (repo: string, path: string) => string): void {
    const side = (s: 'left' | 'right') => () => {
      const t = this.target;
      const p = t?.[s]?.path ?? t?.path;
      return t && p ? abs(t.repo, p) : null;
    };
    nav.attach(this.editor.getOriginalEditor(), side('left'));
    nav.attach(this.editor.getModifiedEditor(), side('right'));
  }

  private setInline(inline: boolean): void {
    this.inline = inline;
    try { localStorage.setItem(INLINE, inline ? '1' : '0'); } catch { /* storage unavailable */ }
    this.editor.updateOptions({ renderSideBySide: !inline });
    for (const b of this.header.querySelectorAll('.segmented button')) {
      const on = (b.textContent === 'Inline') === inline;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  clear(message: string): void {
    this.loading++;
    this.target = null;
    const previous = this.editor.getModel();
    this.editor.setModel(null);
    previous?.original.dispose();
    previous?.modified.dispose();
    this.header.replaceChildren(h('div', { class: 'dim' }, message));
    this.notice.hidden = true;
  }
}
