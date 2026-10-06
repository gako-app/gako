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

  stage(repo: string, paths: string[]): Promise<void> {
    return this.t.request('gitStage', { repo, paths });
  }

  unstage(repo: string, paths: string[]): Promise<void> {
    return this.t.request('gitUnstage', { repo, paths });
  }

  commit(repo: string, message: string, amend: boolean): Promise<{ hash: string }> {
    return this.t.request('gitCommit', { repo, message, amend });
  }
}
