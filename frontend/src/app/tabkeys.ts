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

// The tab keys. ⌘W closes the tab in front on macOS. Elsewhere Ctrl+W does too, except inside a
// terminal, where it stays with the shell (delete a word); Ctrl+Shift+W and Ctrl+F4 close the tab
// anywhere, as in Windows Terminal, GNOME Terminal and VS Code. A terminal can't tell Ctrl+Shift+W
// from Ctrl+W, so no program loses a key to it. Ctrl+Tab and Ctrl+Shift+Tab step through the tabs.

export type TabAction = 'close' | 'next' | 'prev';

type Key = Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/** What a key does to the tabs, or null if it goes on to Monaco or the terminal. */
export function tabKey(e: Key, mac: boolean, inTerminal: boolean): TabAction | null {
  if (e.type !== 'keydown' || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'tab' && e.ctrlKey && !e.metaKey) return e.shiftKey ? 'prev' : 'next';
  if (mac) return key === 'w' && e.metaKey && !e.ctrlKey && !e.shiftKey ? 'close' : null;
  if (!e.ctrlKey || e.metaKey) return null;
  if (key === 'f4' && !e.shiftKey) return 'close';
  if (key === 'w' && (e.shiftKey || !inTerminal)) return 'close';
  return null;
}
