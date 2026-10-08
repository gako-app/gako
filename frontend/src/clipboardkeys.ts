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

// The terminal's copy and paste keys off macOS, where the app menu's ⌘C and ⌘V do it. Elsewhere
// Ctrl+C and Ctrl+V belong to the program (interrupt, and the agents' own image paste), so the keys
// are the ones Windows Terminal and VS Code use: Ctrl+Shift+C and Ctrl+Shift+V, Ctrl+Insert and
// Shift+Insert, and on Windows Ctrl+C while text is selected.

export type Platform = 'mac' | 'windows' | 'linux';

export function platformOf(navigatorPlatform: string): Platform {
  if (navigatorPlatform.startsWith('Mac')) return 'mac';
  if (navigatorPlatform.startsWith('Win')) return 'windows';
  return 'linux';
}

type Key = Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/** What a key does to the clipboard, or null if it goes to the program. */
export function clipboardKey(e: Key, platform: Platform, hasSelection: boolean): 'copy' | 'paste' | null {
  if (platform === 'mac' || e.type !== 'keydown' || e.altKey || e.metaKey) return null;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && e.shiftKey && key === 'c') return 'copy';
  if (e.ctrlKey && e.shiftKey && key === 'v') return 'paste';
  if (e.ctrlKey && !e.shiftKey && key === 'insert') return 'copy';
  if (!e.ctrlKey && e.shiftKey && key === 'insert') return 'paste';
  if (platform === 'windows' && e.ctrlKey && !e.shiftKey && key === 'c' && hasSelection) return 'copy';
  return null;
}
