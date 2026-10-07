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
import { defineConfig, type Plugin } from 'vite';

/** git's output, or '' outside a repository (a source archive) or without git. */
function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** The pages' content security policy: Gako's own scripts, workers, fonts and files, images from
 * them or inlined, and connections to the core on the loopback interface. Styles may be inline,
 * since Monaco and xterm.js set them. The dev server also needs its hot-reload connection. */
function csp(dev: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ws://127.0.0.1:*${dev ? ' ws://localhost:*' : ''}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Puts the policy in every page's head, straight after the charset (which must stay within the
 * page's first 1,024 bytes) and before anything it governs. */
const contentSecurityPolicy: Plugin = {
  name: 'gako-csp',
  transformIndexHtml: {
    order: 'post',
    handler: (html, ctx) =>
      html.replace(/<meta charset="UTF-8" \/>/, (m) => `${m}\n    <meta http-equiv="Content-Security-Policy" content="${csp(!!ctx.server)}" />`),
  },
};

// Relative asset paths, so the build loads from the shell's custom protocol (app://).
export default defineConfig({
  base: './',
  plugins: [contentSecurityPolicy],
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
      // The app, its About window, and the measurement harness that bench/ drives.
      input: { index: 'index.html', about: 'about.html', bench: 'bench.html' },
    },
  },
  worker: {
    format: 'es',
  },
});
