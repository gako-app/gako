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

// The one place that knows which shell the frontend runs in. It finds out how to reach gako-core,
// and whether the shell offers a native folder picker and an About window; everything else goes
// through the Transport.
//
// - Tauri injects `window.__GAKO_BOOT__` with an initialization script.
// - Electron exposes `window.__GAKO_BOOT__` and `window.__GAKO_SHELL__` from its preload script.
// - In a plain browser (development), pass `?core=ws://127.0.0.1:PORT&token=TOKEN`. There's no
//   folder picker there: folders are opened by typing their path.

export interface Boot {
  url: string;
  token: string;
  shell: string;
  /** The shell's native folder picker, if it has one: the folder chosen, or null if cancelled. */
  pickFolder?: (defaultPath?: string) => Promise<string | null>;
  /** The shell's About window, if it has one, on its about, licence or notices tab. */
  showAbout?: (tab?: 'about' | 'licence' | 'notices') => void;
}

declare global {
  interface Window {
    __GAKO_BOOT__?: Boot;
    __GAKO_SHELL__?: { pickFolder?: Boot['pickFolder']; showAbout?: Boot['showAbout'] };
  }
}

export function boot(): Boot {
  if (window.__GAKO_BOOT__) {
    return { ...window.__GAKO_BOOT__, pickFolder: window.__GAKO_SHELL__?.pickFolder, showAbout: window.__GAKO_SHELL__?.showAbout };
  }
  const q = new URLSearchParams(location.search);
  const url = q.get('core');
  const token = q.get('token');
  if (!url || !token) {
    throw new Error('No core address: start Gako from a shell, or open with ?core=ws://…&token=…');
  }
  return { url, token, shell: 'browser' };
}
