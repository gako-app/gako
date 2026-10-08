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

/** The editor options the settings' `fileFont…` keys set. */
export function fontOptions(s: Settings): monaco.editor.IEditorOptions {
  return { fontFamily: s.fileFontFamily, fontSize: s.fileFontSize, fontLigatures: s.fileFontLigatures };
}

export { monaco };
