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

/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

/** git's output, or '' outside a repository (a source archive) or without git. */
function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Relative asset paths, so the same build loads from Tauri's and Electron's custom protocols.
export default defineConfig({
  base: './',
  // What the About window shows as the build: the nearest tag, commits since and the commit
  // (v0.9.0-3-gabc1234), marked when built from uncommitted changes; and the commit's date.
  define: {
    __GAKO_BUILD__: JSON.stringify({
      describe: git('describe', '--tags', '--always', '--dirty=-modified') || 'unknown',
      date: git('log', '-1', '--format=%cs'),
    }),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      // The app, its About window, and the phase 0 measurement harness that bench/ drives.
      input: { index: 'index.html', about: 'about.html', bench: 'bench.html' },
    },
  },
  worker: {
    format: 'es',
  },
});
