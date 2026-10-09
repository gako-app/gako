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

// The key that closes the tab in front: ⌘W on macOS, Ctrl+W elsewhere. Inside a terminal on Linux,
// Ctrl+W stays with the shell (delete a word, which bash, zsh and readline all bind), so Ctrl+Shift+W
// closes it there, as in GNOME Terminal and Windows Terminal. On Windows Ctrl+W closes a terminal
// too: cmd and PowerShell don't bind it, and the agents' own delete-word key goes with it.

import type { Platform } from './clipboardkeys';

type Key = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/** Whether a keydown closes the tab in front, a terminal one if inTerminal. */
export function isCloseTab(e: Key, platform: Platform, inTerminal: boolean): boolean {
  if (e.key.toLowerCase() !== 'w' || e.altKey) return false;
  if (platform === 'mac') return e.metaKey && !e.ctrlKey && !e.shiftKey;
  if (!e.ctrlKey || e.metaKey) return false;
  if (e.shiftKey) return inTerminal;
  return !inTerminal || platform === 'windows';
}
