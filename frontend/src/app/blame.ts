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

// Who last changed the line under the cursor, for the status bar: in the file viewer, or on either
// side of a diff. A file's blame at a revision is asked for once, when the cursor first lands in
// it, and kept until its text or its repo's status changes; moving the cursor only looks it up.

import type { Git } from './git';
import type { Blame, BlameCommit } from './model';

/** A file at a revision: 'worktree', 'index', or a commit ('HEAD', a hash). */
export interface BlameSource {
  repo: string;
  rev: string;
  /** In the repo, '/'-separated. */
  path: string;
}

export interface BlameLine {
  repo: string;
  /** The file blamed, at the revision shown. */
  source: BlameSource;
  commit: BlameCommit;
  /** Not committed yet: the line has changes in the working tree or the index. */
  uncommitted: boolean;
}

const keyOf = (s: BlameSource) => `${s.repo}\x1f${s.rev}\x1f${s.path}`;

export class BlameTracker {
  private cache = new Map<string, { repo: string; blame: Promise<Blame | null> }>();
  private want: { source: BlameSource; line: number } | null = null;
  private on = true;
  current: BlameLine | null = null;

  constructor(
    private git: Git,
    /** The line shown changed. */
    private onChange: () => void,
  ) {}

  /** The `blame` setting: off, nothing is asked of git and nothing shows. */
  set enabled(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    if (!on) this.cache.clear();
    this.update();
  }

  /** The cursor is on `line` of `source`; null when no text with a history is in front. */
  at(source: BlameSource | null, line: number | null): void {
    this.want = source && line ? { source, line } : null;
    this.update();
  }

  /** Forgets a file's blame at a revision (its text changed). */
  forget(source: BlameSource): void {
    this.cache.delete(keyOf(source));
    if (this.want && keyOf(this.want.source) === keyOf(source)) this.update();
  }

  /** Forgets every blame in a repo (its status changed: a commit, a file staged). */
  forgetRepo(repo: string): void {
    for (const [k, v] of this.cache) if (v.repo === repo) this.cache.delete(k);
    if (this.want?.source.repo === repo) this.update();
  }

  private update(): void {
    const want = this.on ? this.want : null;
    if (!want) {
      this.set(null);
      return;
    }
    const { source, line } = want;
    const key = keyOf(source);
    let entry = this.cache.get(key);
    if (!entry) {
      entry = { repo: source.repo, blame: this.git.blame(source.repo, source.rev, source.path).catch(() => null) };
      this.cache.set(key, entry);
    }
    entry.blame.then((b) => {
      if (this.want !== want || !this.on) return;
      const i = b?.lines[line - 1];
      const commit = i === undefined ? undefined : b!.commits[i];
      this.set(commit ? { repo: source.repo, source, commit, uncommitted: /^0+$/.test(commit.hash) } : null);
    });
  }

  private set(line: BlameLine | null): void {
    const same = line?.commit === this.current?.commit && line?.repo === this.current?.repo;
    this.current = line;
    if (!same) this.onChange();
  }
}
