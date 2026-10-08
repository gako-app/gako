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

// The diff panel: Monaco's diff editor, read-only, with a header for what's shown and what can be
// done with it. When the file changes on disk while it's open, the diff updates in place.

import { fontOptions, languageFor, monaco, restoreView, setText } from '../monaco';
import { basename, delay, dirname, fill, freeze, h, settled } from './dom';
import type { DiffTarget, FileContent, Settings, Side } from './model';
import type { Git } from './git';
import type { Navigator } from './navigate';
import { type Editors, type Spot, spotIn } from './editors';
import { icon, iconButton, type IconName } from './icons';
import { mediaType } from './media';
import { type MediaView, mediaView } from './mediaview';

const LAYOUT = 'gako.diffLayout';

/** How diffs are laid out: side by side, inline, or side by side unless the diff is narrower than
 * 900 px (Monaco's own rule, as in VS Code). */
type Layout = 'auto' | 'side' | 'inline';
const LAYOUTS: { layout: Layout; icon: IconName; tip: string }[] = [
  { layout: 'auto', icon: 'layout-auto', tip: 'Automatic: side by side, or inline when the diff is narrow' },
  { layout: 'side', icon: 'side-by-side', tip: 'Side by side' },
  { layout: 'inline', icon: 'inline', tip: 'Inline' },
];

/** Monaco's options for a layout. */
function layoutOptions(layout: Layout): monaco.editor.IDiffEditorOptions {
  return { renderSideBySide: layout !== 'inline', useInlineViewWhenSpaceIsLimited: layout === 'auto' };
}

const KIND_LABEL: Record<DiffTarget['kind'], string> = {
  unstaged: 'Index ↔ working tree',
  staged: 'HEAD ↔ index (staged)',
  conflict: 'HEAD ↔ working tree (conflict)',
  commit: 'Commit',
};

/** Where a side comes from: the working tree, the index, a commit, or nowhere. */
function sideLabel(s: Side | null): string {
  return s ? (s.rev === 'worktree' ? 'working tree' : s.rev === 'index' ? 'index' : s.rev.slice(0, 7)) : '(none)';
}

/** The media type a diff shows, if its file is an image or a PDF on either side. */
function diffMedia(t: DiffTarget) {
  return mediaType(t.right?.path ?? t.left?.path ?? t.path);
}

export interface DiffActions {
  prev?: () => void;
  next?: () => void;
  back?: () => void;
  /** Throws away the changes shown (after asking). */
  revert?: () => void;
  /** The working-tree file shown on the right, which can be opened in the viewer or an editor. */
  file?: string;
  repoName: string;
}

export class DiffPanel {
  readonly el = h('section', { class: 'diff' });
  private header = h('header', { class: 'diff-header' });
  private notice = h('div', { class: 'diff-notice' });
  private host = h('div', { class: 'diff-editor' });
  /** Where an image's or a PDF's two sides show instead of the editor. */
  private mediaHost = h('div', { class: 'media-host pair', hidden: true });
  private media: MediaView[] = [];
  private editor: monaco.editor.IStandaloneDiffEditor;
  target: DiffTarget | null = null;
  private loading = 0;
  private layout: Layout = 'auto';

  constructor(private git: Git, private editors: Editors, private openFile: (spot: Spot) => void) {
    try {
      const saved = localStorage.getItem(LAYOUT);
      if (saved === 'side' || saved === 'inline' || saved === 'auto') this.layout = saved;
    } catch { /* storage unavailable */ }
    this.el.append(this.header, this.notice, this.host, this.mediaHost);
    this.editor = monaco.editor.createDiffEditor(this.host, {
      readOnly: true,
      domReadOnly: true,
      originalEditable: false,
      automaticLayout: true,
      ...layoutOptions(this.layout),
      hideUnchangedRegions: { enabled: true },
      theme: 'vs-dark',
      fontSize: 12,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
  }

  /** Applies the settings' file font, to both sides. */
  configure(settings: Settings): void {
    this.editor.updateOptions(fontOptions(settings));
  }

  private async side(repo: string, side: Side | null, raw: boolean): Promise<FileContent | null> {
    if (!side) return null;
    return this.git.file(repo, side.rev, side.path, raw);
  }

  private disposeMedia(): void {
    for (const m of this.media) m.dispose();
    this.media = [];
    this.mediaHost.replaceChildren();
  }

  /** Shows a diff, resolving once it's drawn as it will stay: the diff computed, unchanged regions
   * folded, the scroll position back. With `keepView`, the scroll position survives (a refresh of the
   * same file); otherwise `saved` restores a position saved earlier (a tab shown again). Another
   * file's diff isn't shown while this one loads. */
  async show(target: DiffTarget, actions: DiffActions, keepView = false, saved?: unknown): Promise<void> {
    const ticket = ++this.loading;
    // The panel shows this diff already (a refresh, or its tab shown again after another view).
    const shown = !!this.target && JSON.stringify(this.target) === JSON.stringify(target) && this.editor.getModel() !== null;
    const same = keepView && shown;
    this.target = target;
    this.renderHeader(target, actions);
    if (!shown) this.setStale(true);
    const type = diffMedia(target);
    const [left, right] = await Promise.all([this.side(target.repo, target.left, !!type), this.side(target.repo, target.right, !!type)]);
    if (ticket !== this.loading) return; // a newer request won
    // The same diff again (a file changed in its repo, often another one, or its tab shown again):
    // its models are updated in place, if at all, and the diff editor works out the new diff itself.
    // Nothing is redrawn but what changed, so an agent's edits don't make it flash, and coming back
    // to it costs nothing.
    const current = this.editor.getModel();
    if (shown && current && !type && !left?.binary && !right?.binary && !left?.truncated && !right?.truncated && this.host.hidden === false) {
      setText(current.original, left?.text ?? '');
      setText(current.modified, right?.text ?? '');
      this.notice.hidden = true;
      if (!keepView) restoreView(this.editor.getModifiedEditor(), saved);
      this.setStale(false);
      return;
    }
    const thaw = same ? freeze(this.el) : null;
    try {
      await this.draw(ticket, target, left, right, type, same, saved);
    } finally {
      thaw?.();
    }
  }

  /** Hides what the editor and the media show (another file's diff) while the next one loads. */
  private setStale(stale: boolean): void {
    this.host.classList.toggle('stale', stale);
    this.mediaHost.classList.toggle('stale', stale);
  }

  private async draw(ticket: number, target: DiffTarget, left: FileContent | null, right: FileContent | null,
    type: ReturnType<typeof diffMedia>, same: boolean | null, saved?: unknown): Promise<void> {
    this.disposeMedia();
    this.host.hidden = !!type;
    this.mediaHost.hidden = !type;
    if (type) {
      // An image or a PDF: before and after, side by side, as they are.
      this.notice.hidden = true;
      this.media = [
        mediaView(left, type, target.left ? 'Not there.' : 'New: nothing before.'),
        mediaView(right, type, target.right ? 'Not there.' : 'Deleted.'),
      ];
      const head = (side: Side | null, which: string) => h('div', { class: 'media-side-head' }, `${which} · ${sideLabel(side)}`);
      this.mediaHost.append(
        h('div', { class: 'media-side' }, head(target.left, 'Before'), this.media[0].el),
        h('div', { class: 'media-side' }, head(target.right, 'After'), this.media[1].el));
      const previous = this.editor.getModel();
      this.editor.setModel({ original: monaco.editor.createModel(''), modified: monaco.editor.createModel('') });
      previous?.original.dispose();
      previous?.modified.dispose();
      this.setStale(false);
      return;
    }
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
    // The diff is computed in a worker; when it's in, the sides are coloured, lined up and folded,
    // which moves what's shown. The scroll position goes back after that, and only then is the
    // diff shown.
    // The event also comes when a diff is dropped (another model set): it counts once this model's
    // diff is in.
    let listener: monaco.IDisposable | undefined;
    const computed = new Promise<void>((resolve) => {
      listener = this.editor.onDidUpdateDiff(() => {
        if (this.editor.getModel()?.modified === model.modified && this.editor.getLineChanges() !== null) resolve();
      });
    });
    this.editor.setModel(model);
    previous?.original.dispose();
    previous?.modified.dispose();
    await Promise.race([computed, delay(1000)]);
    listener?.dispose();
    if (ticket !== this.loading) return;
    if (view) this.editor.getModifiedEditor().restoreViewState(view);
    // Drawn now rather than at the next frame, so it's whole when shown however busy the window is.
    this.editor.getOriginalEditor().render(true);
    this.editor.getModifiedEditor().render(true);
    this.setStale(false);
    await settled(this.el);
  }

  private renderHeader(t: DiffTarget, a: DiffActions): void {
    const renamed = t.left && t.right && t.left.path !== t.right.path ? `${t.left.path} → ` : '';
    const what = t.kind === 'commit' ? `Commit ${t.hash?.slice(0, 7)}` : KIND_LABEL[t.kind];
    fill(this.header,
      a.back ? h('button', { class: 'link', onclick: a.back }, '← Back') : null,
      h('div', { class: 'diff-title' },
        h('span', { class: 'dim' }, `${a.repoName}/${dirname(t.path) ? dirname(t.path) + '/' : ''}`),
        h('span', { class: 'diff-name' }, basename(t.path)),
        renamed ? h('span', { class: 'dim' }, ` (renamed from ${renamed.slice(0, -3)})`) : null),
      h('div', { class: 'diff-kind dim', 'data-tip': `Left: ${sideLabel(t.left)}. Right: ${sideLabel(t.right)}.` }, what),
      h('div', { class: 'diff-actions' },
        a.file ? iconButton('file', 'Open file, at this line', () => this.openFile(this.spot(a.file!)), { class: 'framed' }) : null,
        a.file ? this.editors.button(() => this.spot(a.file!)) : null,
        a.revert ? iconButton('revert', 'Revert changes', a.revert, { class: 'framed' }) : null,
        diffMedia(t) ? null : this.modeSwitch(),
        iconButton('prev', 'Previous changed file (↑ in the sidebar)', () => a.prev?.(), { class: 'framed', disabled: !a.prev }),
        iconButton('next', 'Next changed file (↓ in the sidebar)', () => a.next?.(), { class: 'framed', disabled: !a.next })),
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

  /** Automatic, side by side or inline, showing which one is on. */
  private modeSwitch(): HTMLElement {
    return h('span', { class: 'segmented', role: 'group' }, LAYOUTS.map((l) => h('button', {
      class: l.layout === this.layout ? 'on' : '', 'aria-pressed': String(l.layout === this.layout),
      'data-layout': l.layout, 'data-tip': l.tip, 'aria-label': l.tip,
      onclick: () => this.setLayout(l.layout),
    }, icon(l.icon))));
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

  private setLayout(layout: Layout): void {
    this.layout = layout;
    try { localStorage.setItem(LAYOUT, layout); } catch { /* storage unavailable */ }
    this.editor.updateOptions(layoutOptions(layout));
    for (const b of this.header.querySelectorAll<HTMLElement>('.segmented button')) {
      const on = b.dataset.layout === layout;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  clear(message: string): void {
    this.loading++;
    this.target = null;
    this.disposeMedia();
    this.setStale(false);
    this.mediaHost.hidden = true;
    this.host.hidden = false;
    const previous = this.editor.getModel();
    this.editor.setModel(null);
    previous?.original.dispose();
    previous?.modified.dispose();
    this.header.replaceChildren(h('div', { class: 'dim' }, message));
    this.notice.hidden = true;
  }
}
