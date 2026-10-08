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

// What the settings screen shows: every setting, in the sections and words of docs/settings.md,
// and how each is edited. A test checks this list against the core's settings and the docs.

import type { Settings } from './model';

/** When a change takes effect, if not at once. */
export type Applies = 'reopen' | 'new terminals' | 'next start';

export type FieldKind =
  | { type: 'number'; min?: number; step?: number }
  | { type: 'bool' }
  | { type: 'text' }
  | { type: 'choice'; options: [string, string][] }
  /** A list of strings, one per line. */
  | { type: 'lines' }
  /** A folder, or none. */
  | { type: 'folder' }
  | { type: 'agents' }
  | { type: 'editor' };

export type Field = FieldKind & {
  key: keyof Settings;
  title: string;
  help: string;
  applies?: Applies;
};

export interface Section {
  title: string;
  fields: Field[];
}

export const SECTIONS: Section[] = [
  {
    title: 'Repositories',
    fields: [
      { key: 'base', title: 'Base folder', type: 'folder', applies: 'next start',
        help: 'The folder to open when none is given on the command line and none was open before.' },
      { key: 'scanDepth', title: 'Scan depth', type: 'number', min: 0, applies: 'reopen',
        help: 'How many folder levels below the base folder to look for repositories.' },
      { key: 'scanIgnore', title: 'Folders never looked into', type: 'lines', applies: 'reopen',
        help: 'Folder names, one per line.' },
      { key: 'extraFolders', title: 'Extra folders', type: 'lines', applies: 'reopen',
        help: 'More folders to look for repositories in, to the same depth; one per line.' },
      { key: 'maxGitProcesses', title: 'Git processes at once', type: 'number', min: 1, applies: 'reopen',
        help: 'How many git processes may run at once.' },
      { key: 'debounceMs', title: 'Quiet time before a refresh', type: 'number', min: 0, applies: 'reopen',
        help: "How long a repository must be quiet after a change before its status is refreshed, in milliseconds." },
      { key: 'untrackedLimit', title: 'Untracked files listed', type: 'number', min: 0, applies: 'reopen',
        help: 'Untracked files listed per repository; the rest are counted.' },
      { key: 'gitTimeoutSecs', title: 'Git timeout', type: 'number', min: 1, applies: 'reopen',
        help: 'Seconds before a git command is given up on.' },
    ],
  },
  {
    title: 'Agents and terminals',
    fields: [
      { key: 'agents', title: 'Agents', type: 'agents',
        help: 'The programs offered when you start a terminal, besides your shell. Each is offered only if its program is found.' },
      { key: 'agentHooks', title: 'Agent hooks', type: 'bool',
        help: "Start Claude Code with Gako's hook, so the agent bar can tell when it's waiting for approval." },
      { key: 'terminalScrollback', title: 'Scrollback', type: 'number', min: 0, applies: 'new terminals',
        help: "Rows kept per terminal. Each row costs memory at the terminal's full width." },
      { key: 'terminalRenderer', title: 'Renderer', type: 'choice', applies: 'new terminals',
        options: [['webgl', 'WebGL'], ['dom', 'DOM: slower, uses less memory']],
        help: 'How terminals are drawn.' },
      { key: 'terminalFontSize', title: 'Font size', type: 'number', min: 1, step: 0.5,
        help: 'In pixels.' },
      { key: 'terminalFontFamily', title: 'Font', type: 'text',
        help: 'A CSS font list: the first one installed is used.' },
      { key: 'terminalFontLigatures', title: 'Font ligatures', type: 'bool',
        help: "Draw the font's ligatures, such as => and != as one sign, if it has any." },
      { key: 'terminalMaxCombining', title: 'Combining marks per character', type: 'number', min: 0, applies: 'new terminals',
        help: 'A longer run is dropped whole. 0 turns the limit off.' },
    ],
  },
  {
    title: 'Files and diffs',
    fields: [
      { key: 'fileFontSize', title: 'Font size', type: 'number', min: 1, step: 0.5,
        help: 'In pixels.' },
      { key: 'fileFontFamily', title: 'Font', type: 'text',
        help: 'A CSS font list: the first one installed is used.' },
      { key: 'fileFontLigatures', title: 'Font ligatures', type: 'bool',
        help: "Draw the font's ligatures, such as => and != as one sign, if it has any." },
    ],
  },
  {
    title: 'Editor',
    fields: [
      { key: 'editor', title: 'Open in', type: 'editor',
        help: 'The editor "Open in editor" uses. Saving it here replaces one picked from the Files view.' },
    ],
  },
];

/** Splits a command line into the program and its arguments: spaces separate them, and quotes
 * ("…" or '…') keep spaces in one. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

/** The command line `splitCommand` reads back as `parts`. */
export function joinCommand(parts: string[]): string {
  return parts.map((p) => (p === '' || /[\s"']/.test(p) ? (p.includes('"') ? `'${p}'` : `"${p}"`) : p)).join(' ');
}
