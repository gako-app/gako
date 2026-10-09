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

// Change markers in the file viewer, as VS Code's editor gutter shows them: a bar beside lines added
// (green) or changed (blue), and a mark where lines were deleted (red), against the last commit, so
// every change not yet committed, staged or not. Clicking a marker opens the change inline: the
// lines as they were, under the lines as they are, with steps to the previous and next change.
//
// The changes come from Monaco's own diff computation (the diff editor's, in its worker), run in a
// hidden diff editor that shares the viewer's model.

import { monaco } from '../monaco';
import { h } from './dom';
import { icon, iconButton } from './icons';

type Kind = 'added' | 'modified' | 'deleted';

interface Hunk {
  kind: Kind;
  /** Lines in the file now (for a deletion, the line it follows; 0 at the very top). */
  start: number;
  end: number;
  /** The lines as they were. */
  before: string[];
}

const DIFF_TIMEOUT_MS = 5000;
/** VS Code's gutter colours (the overview ruler is drawn on a canvas, so not CSS variables). */
const MARKER_COLOUR: Record<Kind, string> = { added: '#487e02', modified: '#1b81a8', deleted: '#f14c4c' };

export class ChangeMarkers {
  private differ: monaco.editor.IStandaloneDiffEditor;
  private hunks: Hunk[] = [];
  private decorations: monaco.editor.IEditorDecorationsCollection;
  private highlight: monaco.editor.IEditorDecorationsCollection;
  /** The open change: a view zone making room under its lines, and an overlay widget drawn in
   * that room (a zone's own content sits under the text layer, where it can't be clicked). */
  private zone: { id: string; hunk: Hunk; widget: monaco.editor.IOverlayWidget; scroll: monaco.IDisposable } | null = null;
  private ticket = 0;

  constructor(private editor: monaco.editor.ICodeEditor) {
    // Off screen and never shown: only its diff computation is used.
    const host = h('div', { class: 'offscreen-differ' });
    document.body.append(host);
    this.differ = monaco.editor.createDiffEditor(host, { readOnly: true, renderSideBySide: false, automaticLayout: false });
    this.decorations = editor.createDecorationsCollection();
    this.highlight = editor.createDecorationsCollection();
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const line = e.target.position?.lineNumber ?? 0;
      const hunk = this.hunks.find((x) => (x.kind === 'deleted' ? line === Math.max(1, x.start) : line >= x.start && line <= x.end));
      if (hunk) this.toggle(hunk);
    });
    // The model is replaced when another file opens or this one reloads: markers go with it.
    editor.onDidChangeModel(() => this.clear());
  }

  /** Marks the changes between `before` (the file at the last commit; '' if it's new) and what the
   * viewer shows; null clears them (the file has no changes). */
  async show(before: string | null): Promise<void> {
    const ticket = ++this.ticket;
    const model = this.editor.getModel();
    if (before === null || !model) {
      this.clear();
      return;
    }
    const original = monaco.editor.createModel(before, model.getLanguageId());
    const changes = await this.compute(original, model);
    original.dispose();
    if (ticket !== this.ticket || this.editor.getModel() !== model) return;
    const beforeLines = before === '' ? [] : before.split(/\r?\n/);
    this.hunks = (changes ?? []).map((c) => {
      const kind: Kind = c.originalEndLineNumber === 0 ? 'added' : c.modifiedEndLineNumber === 0 ? 'deleted' : 'modified';
      const before = kind === 'added' ? [] : beforeLines.slice(c.originalStartLineNumber - 1, c.originalEndLineNumber);
      return kind === 'deleted'
        ? { kind, start: c.modifiedStartLineNumber, end: c.modifiedStartLineNumber, before }
        : { kind, start: c.modifiedStartLineNumber, end: c.modifiedEndLineNumber, before };
    });
    this.closeZone();
    this.decorations.set(this.hunks.map((x) => ({
      range: x.kind === 'deleted'
        ? new monaco.Range(Math.max(1, x.start), 1, Math.max(1, x.start), 1)
        : new monaco.Range(x.start, 1, x.end, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: `change-marker ${x.kind}${x.kind === 'deleted' && x.start === 0 ? ' at-top' : ''}`,
        linesDecorationsTooltip: 'Click to see what changed',
        overviewRuler: { color: MARKER_COLOUR[x.kind], position: monaco.editor.OverviewRulerLane.Left },
      },
    })));
  }

  private compute(original: monaco.editor.ITextModel, modified: monaco.editor.ITextModel): Promise<monaco.editor.ILineChange[] | null> {
    return new Promise((resolve) => {
      const done = (v: monaco.editor.ILineChange[] | null) => {
        clearTimeout(timer);
        sub.dispose();
        this.differ.setModel(null);
        resolve(v);
      };
      const timer = setTimeout(() => done(null), DIFF_TIMEOUT_MS);
      const sub = this.differ.onDidUpdateDiff(() => done(this.differ.getLineChanges()));
      this.differ.setModel({ original, modified });
    });
  }

  clear(): void {
    this.ticket++;
    this.hunks = [];
    this.closeZone();
    this.decorations.clear();
  }

  private toggle(hunk: Hunk): void {
    const same = this.zone?.hunk === hunk;
    this.closeZone();
    if (!same) this.openZone(hunk);
  }

  private closeZone(): void {
    if (!this.zone) return;
    const { id, widget, scroll } = this.zone;
    this.editor.changeViewZones((a) => a.removeZone(id));
    this.editor.removeOverlayWidget(widget);
    scroll.dispose();
    this.zone = null;
    this.highlight.clear();
  }

  /** The change inline, under its lines: what was there before, coloured as code. */
  private openZone(hunk: Hunk): void {
    const i = this.hunks.indexOf(hunk);
    const lang = this.editor.getModel()?.getLanguageId() ?? 'plaintext';
    const lineHeight = this.editor.getOption(monaco.editor.EditorOption.lineHeight);
    const what = hunk.kind === 'added'
      ? `${hunk.end - hunk.start + 1} line${hunk.end === hunk.start ? '' : 's'} added`
      : hunk.kind === 'deleted'
        ? `${hunk.before.length} line${hunk.before.length === 1 ? '' : 's'} deleted`
        : `${hunk.before.length} line${hunk.before.length === 1 ? '' : 's'} changed to ${hunk.end - hunk.start + 1}`;
    const go = (j: number) => {
      const next = this.hunks[j];
      if (!next) return;
      this.closeZone();
      this.editor.revealLineInCenterIfOutsideViewport(Math.max(1, next.start));
      this.openZone(next);
    };
    const old = h('pre', { class: 'change-before', style: `line-height:${lineHeight}px` });
    // As wide as the visible code, not the longest line, so its header's buttons stay in view.
    const info = this.editor.getLayoutInfo();
    const width = info.width - info.contentLeft - info.minimap.minimapWidth - info.verticalScrollbarWidth;
    const peek = h('div', { class: `change-peek ${hunk.kind}`, style: `width:${width}px` },
      h('div', { class: 'change-peek-header' },
        h('span', {}, `${what}, since the last commit`),
        h('span', { class: 'spacer' }),
        h('span', { class: 'dim' }, `${i + 1} of ${this.hunks.length}`),
        iconButton('prev', 'Previous change', () => go(i - 1), { disabled: i === 0 }),
        iconButton('next', 'Next change', () => go(i + 1), { disabled: i === this.hunks.length - 1 }),
        h('button', { class: 'close', 'data-tip': 'Close', onclick: () => this.closeZone() }, icon('close'))),
      hunk.before.length ? old : h('div', { class: 'change-none dim' }, 'Nothing was here before.'));

    if (hunk.before.length) {
      monaco.editor.colorize(hunk.before.join('\n'), lang, {}).then((html) => { old.innerHTML = html; });
    }
    const lines = hunk.before.length || 1;
    const after = hunk.kind === 'deleted' ? hunk.start : hunk.end;
    // Header (28) and borders (4), the lines, and their padding (8).
    const height = 40 + lines * lineHeight;
    peek.style.height = `${height}px`;
    const widget: monaco.editor.IOverlayWidget = { getId: () => 'gako.change', getDomNode: () => peek, getPosition: () => null };
    // The widget follows the room the zone makes as the code scrolls.
    const place = () => {
      const top = (after ? this.editor.getTopForLineNumber(after) + lineHeight : 0) - this.editor.getScrollTop();
      peek.style.top = `${top}px`;
      peek.style.left = `${this.editor.getLayoutInfo().contentLeft}px`;
    };
    this.editor.changeViewZones((a) => {
      const id = a.addZone({ afterLineNumber: after, heightInPx: height, domNode: h('div') });
      this.zone = { id, hunk, widget, scroll: this.editor.onDidScrollChange(place) };
    });
    this.editor.addOverlayWidget(widget);
    place();
    // Brought into view if it ends below the screen: the change's first lines near the top.
    const zoneBottom = this.editor.getTopForLineNumber(Math.max(1, after)) + (after ? lineHeight : 0) + height;
    if (zoneBottom > this.editor.getScrollTop() + this.editor.getLayoutInfo().height) {
      this.editor.setScrollTop(Math.min(this.editor.getTopForLineNumber(Math.max(1, hunk.start)) - 2 * lineHeight, zoneBottom - this.editor.getLayoutInfo().height + lineHeight));
    }
    if (hunk.kind !== 'deleted') {
      this.highlight.set([{ range: new monaco.Range(hunk.start, 1, hunk.end, 1), options: { isWholeLine: true, className: `change-now ${hunk.kind}` } }]);
    }
  }
}
