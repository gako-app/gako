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

// The workspace as the core reports it, and what each kind of diff compares.

export type Change = 'modified' | 'typeChanged' | 'added' | 'deleted' | 'renamed' | 'copied';
export type Conflict =
  | 'bothDeleted' | 'addedByUs' | 'deletedByThem' | 'addedByThem' | 'deletedByUs' | 'bothAdded' | 'bothModified';
export type Operation = 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'bisect';

export interface Entry {
  path: string;
  origPath?: string;
  index?: Change;
  worktree?: Change;
  conflict?: Conflict;
  untracked?: boolean;
  submodule?: boolean;
}

export interface Status {
  oid: string | null;
  branch: string | null;
  upstream: string | null;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  entries: Entry[];
  untrackedOmitted: number;
  operation: Operation | null;
}

export interface RepoInfo {
  root: string;
  rel: string;
  kind: 'normal' | 'worktree' | 'submodule';
}

export interface Repo extends RepoInfo {
  status?: Status;
  error?: string;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
}

export interface CommitDetails extends Omit<Commit, 'subject'> {
  committer: string;
  message: string;
  files: { status: string; path: string; origPath?: string }[];
}

export interface FileContent {
  text: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  /** The bytes, base64-encoded, when asked for (images and PDFs) and within the limit. */
  base64?: string;
}

/** One side of a diff: a file at a revision ('worktree', 'index', or a commit), or nothing. */
export interface Side {
  rev: string;
  path: string;
}

export type DiffKind = 'unstaged' | 'staged' | 'conflict' | 'commit';

export interface DiffTarget {
  repo: string;
  kind: DiffKind;
  path: string;
  left: Side | null;
  right: Side | null;
  /** For commit diffs. */
  hash?: string;
}

export const LETTER: Record<Change, string> = {
  modified: 'M', typeChanged: 'T', added: 'A', deleted: 'D', renamed: 'R', copied: 'C',
};

/** What a diff of this kind compares for this entry. */
export function diffTarget(repo: string, kind: Exclude<DiffKind, 'commit'>, e: Entry): DiffTarget {
  const head = (path: string): Side => ({ rev: 'HEAD', path });
  const original = e.origPath ?? e.path;
  switch (kind) {
    case 'unstaged':
      return {
        repo, kind, path: e.path,
        left: e.untracked ? null : { rev: 'index', path: e.path },
        right: e.worktree === 'deleted' ? null : { rev: 'worktree', path: e.path },
      };
    case 'staged':
      return {
        repo, kind, path: e.path,
        left: e.index === 'added' ? null : head(original),
        right: e.index === 'deleted' ? null : { rev: 'index', path: e.path },
      };
    case 'conflict':
      return {
        repo, kind, path: e.path,
        left: e.conflict === 'addedByThem' || e.conflict === 'bothAdded' ? null : head(e.path),
        right: e.conflict === 'deletedByUs' || e.conflict === 'bothDeleted' ? null : { rev: 'worktree', path: e.path },
      };
  }
}

export function changeCount(s: Status): number {
  return s.entries.length + s.untrackedOmitted;
}

export interface Settings {
  base: string | null;
  scanDepth: number;
  scanIgnore: string[];
  extraFolders: string[];
  maxGitProcesses: number;
  debounceMs: number;
  untrackedLimit: number;
  gitTimeoutSecs: number;
  agents: { name: string; command: string[] }[];
  terminalScrollback: number;
  terminalRenderer: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalFontLigatures: boolean;
  terminalMaxCombining: number;
  terminalCopyOnSelect: boolean;
  /** A known editor's id, or a command line (see editors.ts). */
  editor: unknown;
  agentHooks: boolean;
  fileFontSize: number;
  fileFontFamily: string;
  fileFontLigatures: boolean;
}
