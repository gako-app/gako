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
}

/** One side of a diff: a file at a revision ('worktree', 'index', or a commit), or nothing. */
export interface Side {
  rev: string;
  path: string;
}

export type DiffKind = 'unstaged' | 'staged' | 'review' | 'conflict' | 'commit';

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
    case 'review': {
      // Everything that changed since the last commit, staged or not: what an agent did.
      const added = e.untracked || e.index === 'added';
      const deleted = e.worktree === 'deleted' || (e.index === 'deleted' && !e.worktree);
      return { repo, kind, path: e.path, left: added ? null : head(original), right: deleted ? null : { rev: 'worktree', path: e.path } };
    }
    case 'conflict':
      return {
        repo, kind, path: e.path,
        left: e.conflict === 'addedByThem' || e.conflict === 'bothAdded' ? null : head(e.path),
        right: e.conflict === 'deletedByUs' || e.conflict === 'bothDeleted' ? null : { rev: 'worktree', path: e.path },
      };
  }
}

/** The single-letter badge for an entry in the review queue. */
export function reviewLetter(e: Entry): string {
  if (e.conflict) return '!';
  if (e.untracked) return 'U';
  const c = e.index ?? e.worktree;
  return c ? LETTER[c] : 'M';
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
}
