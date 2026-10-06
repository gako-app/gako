// The diff panel: Monaco's diff editor, read-only, with a header for what's shown and what can be
// done with it. When the file changes on disk while it's open, the diff updates in place.

import { languageFor, monaco } from '../monaco';
import { basename, dirname, fill, h } from './dom';
import type { DiffTarget, FileContent, Side } from './model';
import type { Git } from './git';

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

  constructor(private git: Git) {
    this.el.append(this.header, this.notice, this.host);
    this.editor = monaco.editor.createDiffEditor(this.host, {
      readOnly: true,
      domReadOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
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

  /** Shows a diff. With `keepView`, the scroll position survives (a refresh of the same file). */
  async show(target: DiffTarget, actions: DiffActions, keepView = false): Promise<void> {
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
    const view = same ? this.editor.getModifiedEditor().saveViewState() : null;
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
        a.stage ? h('button', { onclick: a.stage, title: 'Stage this file' }, 'Stage') : null,
        a.unstage ? h('button', { onclick: a.unstage, title: 'Unstage this file' }, 'Unstage') : null,
        h('button', { onclick: () => this.toggleInline(), title: 'Side by side or inline' }, 'Inline'),
        h('button', { onclick: a.prev, disabled: !a.prev, title: 'Previous file (↑)' }, '↑'),
        h('button', { onclick: a.next, disabled: !a.next, title: 'Next file (↓)' }, '↓')),
    );
  }

  private toggleInline(): void {
    const inline = this.el.classList.toggle('inline');
    this.editor.updateOptions({ renderSideBySide: !inline });
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
