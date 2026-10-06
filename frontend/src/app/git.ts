// Typed requests to the core's workspace and Git side.

import type { Transport } from '../transport';
import type { Commit, CommitDetails, FileContent, RepoInfo, Settings, Status } from './model';

export interface Opened {
  base: string;
  settings: Settings;
  settingsFiles: { user: string | null; workspace: string };
  repos: RepoInfo[];
  statuses: ({ repo: string } & ({ status: Status } | { error: string }))[];
}

export class Git {
  constructor(private t: Transport) {}

  open(base?: string): Promise<Opened> {
    return this.t.request('workspaceOpen', { base: base ?? null });
  }

  file(repo: string, rev: string, path: string): Promise<FileContent | null> {
    return this.t.request('gitFile', { repo, rev, path });
  }

  log(repo: string, skip: number, limit: number): Promise<Commit[]> {
    return this.t.request('gitLog', { repo, skip, limit });
  }

  details(repo: string, hash: string): Promise<CommitDetails> {
    return this.t.request('gitCommitDetails', { repo, hash });
  }

  /** Fetches, pulls (fast-forward only) or pushes; the repo's status follows. */
  remote(repo: string, action: 'fetch' | 'pull' | 'push'): Promise<void> {
    return this.t.request(`git${action[0].toUpperCase()}${action.slice(1)}`, { repo });
  }
}
