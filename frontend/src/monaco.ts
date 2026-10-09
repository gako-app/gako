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

// Monaco, set up once for the whole frontend: the editor API, its one worker (diff computation),
// and syntax highlighting for every language Monaco has a tokenizer for, each loaded on first use.
// No language services: a read-only viewer doesn't need them.

import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/register.all.js';
// The icon font (diff gutter markers, folded-region icons); editor.api.js alone doesn't load it.
import 'monaco-editor/features/codicon/register.js';
// Find in the file (⌘F, Ctrl+F) and its widget; read-only editors leave replace out by themselves.
import 'monaco-editor/features/find/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import type { Settings } from './app/model';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// JSON only ships as a full language service; its JavaScript tokenizer is enough to read it.
const aliases: Record<string, string> = { json: 'javascript', jsonc: 'javascript', json5: 'javascript' };

/** The Monaco language for a file path, by extension or file name; plain text otherwise. */
export function languageFor(path: string): string {
  const name = path.split('/').pop()!.toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  if (aliases[ext.slice(1)]) return aliases[ext.slice(1)];
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
    if (ext && lang.extensions?.includes(ext)) return lang.id;
  }
  return 'plaintext';
}

/** Makes `model` hold `text` by replacing only the part that differs (between what the two have in
 * common at the start and at the end), so the rest of what's shown, the scroll position and the
 * decorations stay put: a file that changed on disk is updated the way an edit would update it.
 * False if there was nothing to change. */
export function setText(model: monaco.editor.ITextModel, text: string): boolean {
  const old = model.getValue();
  if (old === text) return false;
  const max = Math.min(old.length, text.length);
  let start = 0;
  while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
  // Never between the two halves of a line break or of a surrogate pair.
  const low = (s: string, i: number) => i >= 0 && i < s.length && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff;
  if (start > 0 && (old[start - 1] === '\r' || low(old, start))) start--;
  if (end > 0 && (old[old.length - end] === '\n' || low(old, old.length - end))) end--;
  const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(old.length - end));
  model.applyEdits([{ range, text: text.slice(start, text.length - end) }]);
  return true;
}

/** Puts an editor back where `state` says, unless it's there already: any scroll, even to where it
 * is, makes Monaco show its scrollbars for a moment, which a tab shown again shouldn't do. */
export function restoreView(editor: monaco.editor.ICodeEditor, state: unknown): void {
  const saved = state as monaco.editor.ICodeEditorViewState | null | undefined;
  if (!saved) return;
  if (JSON.stringify(editor.saveViewState()?.viewState) === JSON.stringify(saved.viewState)) return;
  editor.restoreViewState(saved);
}

/** Opens Monaco's find widget on `editor`, as ⌘F (Ctrl+F) does with the focus in it. False if the
 * editor holds nothing to search. */
export function openFind(editor: monaco.editor.ICodeEditor): boolean {
  if (!editor.getModel()) return false;
  editor.focus();
  editor.getAction('actions.find')?.run();
  return true;
}

/** The editor options the settings' `fileFont…` keys set. */
export function fontOptions(s: Settings): monaco.editor.IEditorOptions {
  return { fontFamily: s.fileFontFamily, fontSize: s.fileFontSize, fontLigatures: s.fileFontLigatures };
}

export { monaco };
