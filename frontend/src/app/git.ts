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

// Typed requests to the core's workspace and Git side.

import type { Transport } from '../transport';
import type { Commit, CommitDetails, FileContent, RepoInfo, Settings, Status } from './model';

export interface Opened {
  base: string;
  settings: Settings;
  repos: RepoInfo[];
  statuses: ({ repo: string } & ({ status: Status } | { error: string }))[];
}

export class Git {
  constructor(private t: Transport) {}

  open(base?: string): Promise<Opened> {
    return this.t.request('workspaceOpen', { base: base ?? null });
  }

  /** A file at a revision; with `raw`, its bytes rather than its text (for images and PDFs). */
  file(repo: string, rev: string, path: string, raw = false): Promise<FileContent | null> {
    return this.t.request('gitFile', { repo, rev, path, raw });
  }

  log(repo: string, skip: number, limit: number): Promise<Commit[]> {
    return this.t.request('gitLog', { repo, skip, limit });
  }

  details(repo: string, hash: string): Promise<CommitDetails> {
    return this.t.request('gitCommitDetails', { repo, hash });
  }

  /** Throws away a file's changes in one group of the repos view: changes not staged go back to
   * the index, an untracked file is deleted, staged changes go back to HEAD. */
  revert(repo: string, group: 'changes' | 'untracked' | 'staged', path: string, origPath?: string): Promise<void> {
    return this.t.request('gitRevert', { repo, group, path, origPath: origPath ?? null });
  }

  /** Local branches, and remote ones with no local branch of that name; most recent first. */
  branches(repo: string): Promise<{ local: string[]; remote: string[] }> {
    return this.t.request('gitBranches', { repo });
  }

  /** Switches to a local branch, or to a new one tracking a remote branch. */
  switch(repo: string, branch: string, remote: boolean): Promise<void> {
    return this.t.request('gitSwitch', { repo, branch, remote });
  }

  /** Fetches, pulls (fast-forward only) or pushes; the repo's status follows. */
  remote(repo: string, action: 'fetch' | 'pull' | 'push'): Promise<void> {
    return this.t.request(`git${action[0].toUpperCase()}${action.slice(1)}`, { repo });
  }
}
