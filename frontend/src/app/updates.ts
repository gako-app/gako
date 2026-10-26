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

// Whether a newer Gako has been released. The shell asks GitHub for the latest release (boot.ts,
// latestRelease); this decides when to ask and whether the answer is newer than the running
// version. Nothing is downloaded: the status bar links to the release page.

import type { Release } from '../boot';

/** The first check, a little after the start so it doesn't compete with opening the folder. */
const FIRST_MS = 10_000;
const EVERY_MS = 6 * 60 * 60 * 1000;

/** `a` and `b` compared as semantic versions (a leading "v" allowed): negative if `a` is older. A
 * pre-release comes before its release (0.23.0-beta.2 < 0.23.0). Null if either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
    return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4]?.split('.') ?? [] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return +p - +q;
    // Numbers come before words.
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

export class Updates {
  /** The newer release found, if any. */
  available: Release | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private on = false;
  private ask: () => Promise<{ current: string; latest: Release | null }>;
  private changed: () => void;

  /** `ask`: the shell's latestRelease. `changed`: called when `available` changes. */
  constructor(ask: () => Promise<{ current: string; latest: Release | null }>, changed: () => void) {
    this.ask = ask;
    this.changed = changed;
  }

  /** The `updates` setting: "notify" checks now and then, "off" stops and forgets what was found. */
  configure(setting: string): void {
    const on = setting !== 'off';
    if (on === this.on) return;
    this.on = on;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (on) this.timer = setTimeout(() => this.check(), FIRST_MS);
    else if (this.available) {
      this.available = null;
      this.changed();
    }
  }

  private async check(): Promise<void> {
    try {
      const { current, latest } = await this.ask();
      const found = latest && (compareVersions(latest.version, current) ?? 0) > 0 ? latest : null;
      if (this.on && found?.version !== this.available?.version) {
        this.available = found;
        this.changed();
      }
    } catch (e) {
      // Offline, or GitHub unreachable: the next check may do better.
      console.warn(`gako: checking for updates failed: ${(e as Error).message ?? e}`);
    }
    if (this.on) this.timer = setTimeout(() => this.check(), EVERY_MS);
  }
}
