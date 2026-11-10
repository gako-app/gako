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

// A repo's history, or one file's: the commit log (loading more as it scrolls) and the selected
// commit's details. Clicking a file in a commit opens its diff against the commit's first parent. A
// file's history lists the commits that changed it, back through its renames; the file comes first
// in each commit's details, and a double click on a commit opens its diff straight away. The file
// as a commit left it can be compared with the working tree.

import { basename, dirname, fill, h, relativeTime } from './dom';
import { formatDateTime } from './dates';
import type { Git } from './git';
import { iconButton } from './icons';
import type { Commit, CommitDetails, CommitFile, DiffTarget, Repo } from './model';

const PAGE = 200;

export class HistoryPanel {
  readonly el = h('section', { class: 'history' });
  private header = h('header', { class: 'diff-header' });
  private commits = h('div', { class: 'commits' });
  private details = h('div', { class: 'commit-details' });
  private repo: Repo | null = null;
  /** The file whose history this is (relative to the repo, with /), or null for the whole repo's. */
  private path: string | null = null;
  /** In a file's history, the file as each commit loaded changed it. */
  private followed = new Map<string, CommitFile>();
  private loaded = 0;
  private done = false;
  private loading = false;
  private selected: string | null = null;
  /** A commit to show once the history is shown (from the status bar's blame). */
  private reveal: string | null = null;

  constructor(
    private git: Git,
    /** Opens a file's diff in a commit; `path` is the file whose history it was opened from. */
    private openDiff: (target: DiffTarget, repo: Repo, path: string | null) => void,
    private repoName: (r: Repo) => string,
    /** Compares a file as commit `hash` left it (at `then`, its path in that commit) with the
     * working tree; `path` is the file whose history it is. */
    private compare: (repo: Repo, hash: string, then: string, path: string) => void,
  ) {
    this.el.append(this.header, h('div', { class: 'history-body' }, this.commits, this.details));
    this.commits.addEventListener('scroll', () => {
      const c = this.commits;
      if (c.scrollTop + c.clientHeight > c.scrollHeight - 400) this.more();
    });
  }

  /** Shows the repo's history, or with `path` the history of that file in it. */
  async show(repo: Repo, path: string | null = null): Promise<void> {
    if (this.repo?.root !== repo.root || this.path !== path) {
      this.repo = repo;
      this.path = path;
      this.followed.clear();
      this.loaded = 0;
      this.done = false;
      this.selected = null;
      this.commits.replaceChildren();
      this.details.replaceChildren(h('div', { class: 'empty dim' },
        path ? 'Select a commit, or double-click one to see how it changed this file.' : 'Select a commit.'));
    }
    const title = path
      ? [h('span', { class: 'dim' }, `${this.repoName(repo)}/${dirname(path) ? dirname(path) + '/' : ''}`),
        h('span', { class: 'diff-name' }, basename(path))]
      : [h('span', { class: 'diff-name' }, this.repoName(repo))];
    this.header.replaceChildren(h('div', { class: 'diff-title' }, ...title, h('span', { class: 'dim' }, ' history')));
    if (this.loaded === 0) await this.more();
    const hash = this.reveal;
    this.reveal = null;
    if (hash && this.repo === repo) {
      const row = this.commits.querySelector<HTMLElement>(`.commit[data-hash="${hash}"]`);
      row?.scrollIntoView({ block: 'center' });
      await this.select(hash, row);
    }
  }

  /** Selects `hash` when the history is next shown. A commit further down than the rows loaded
   * shows its details without a row selected. */
  revealNext(hash: string): void {
    this.reveal = hash;
  }

  /** Reloads from the top, after a commit. */
  async refresh(repo: Repo): Promise<void> {
    if (this.repo?.root !== repo.root) return;
    this.repo = null;
    await this.show(repo, this.path);
  }

  private async more(): Promise<void> {
    if (!this.repo || this.done || this.loading) return;
    this.loading = true;
    const repo = this.repo;
    const path = this.path;
    try {
      const page = await this.git.log(repo.root, this.loaded, PAGE, path ?? undefined);
      if (repo !== this.repo || path !== this.path) return;
      this.loaded += page.length;
      this.done = page.length < PAGE;
      for (const c of page) if (c.file) this.followed.set(c.hash, c.file);
      this.commits.append(...page.map((c) => this.row(c)));
      if (this.loaded === 0) {
        this.commits.append(h('div', { class: 'empty dim' }, path ? 'No commits have changed this file.' : 'No commits yet.'));
      }
    } finally {
      this.loading = false;
    }
  }

  private row(c: Commit): HTMLElement {
    const f = c.file;
    const repo = this.repo;
    // In a file's history, where the file was then, when it had another name.
    const was = f && this.path && f.path !== this.path ? ` · as ${f.path}` : '';
    const el = h('div', {
      class: 'commit', 'data-hash': c.hash, onclick: () => this.select(c.hash, el),
      ondblclick: f && repo ? () => this.openDiff(this.target(repo, c.hash, c.parents[0], f), repo, this.path) : undefined,
    },
    h('div', { class: 'subject' }, c.subject),
    h('div', { class: 'meta dim' }, `${c.hash.slice(0, 7)} · ${c.author} · ${relativeTime(c.time)}${was}`));
    if (c.hash === this.selected) el.classList.add('selected');
    return el;
  }

  private async select(hash: string, el: HTMLElement | null): Promise<void> {
    if (!this.repo) return;
    this.selected = hash;
    for (const s of this.commits.querySelectorAll('.commit.selected')) s.classList.remove('selected');
    el?.classList.add('selected');
    const repo = this.repo;
    const d = await this.git.details(repo.root, hash);
    if (repo !== this.repo || this.selected !== hash) return;
    this.renderDetails(repo, d);
  }

  /** A file's diff in a commit, against the commit's first parent. */
  private target(repo: Repo, hash: string, parent: string | undefined, f: CommitFile): DiffTarget {
    return {
      repo: repo.root, kind: 'commit', path: f.path, hash,
      left: f.status === 'A' || !parent ? null : { rev: parent, path: f.origPath ?? f.path },
      right: f.status === 'D' ? null : { rev: hash, path: f.path },
    };
  }

  private renderDetails(repo: Repo, d: CommitDetails): void {
    const [subject, ...body] = d.message.split('\n');
    const parent = d.parents[0];
    // In a file's history, the file as the log found it in this commit, listed apart and first.
    const own = this.path ? this.followed.get(d.hash) : undefined;
    const mine = own ? d.files.find((f) => f.path === own.path) : undefined;
    const others = mine ? d.files.filter((f) => f !== mine) : d.files;
    const fileRow = (f: CommitFile) => h('div', {
      class: `file st-${f.status}${f === mine ? ' selected' : ''}`, title: f.origPath ? `${f.origPath} → ${f.path}` : f.path,
      onclick: () => this.openDiff(this.target(repo, d.hash, parent, f), repo, this.path),
    }, h('span', { class: 'letter' }, f.status), h('span', { class: 'fname' }, basename(f.path)),
    h('span', { class: 'fdir dim' }, dirname(f.path)),
    // The file as this commit left it, against the file now (not for the commit that deleted it).
    f === mine && this.path && f.status !== 'D'
      ? iconButton('compare', 'Compare with the current file', () => this.compare(repo, d.hash, f.path, this.path!), { class: 'compare' })
      : null);
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'} changed`;
    fill(this.details,
      h('div', { class: 'subject big' }, subject),
      body.join('\n').trim() ? h('pre', { class: 'body' }, body.join('\n').trim()) : null,
      h('div', { class: 'meta dim' },
        `${d.hash.slice(0, 10)} · ${d.author} <${d.email}> · ${formatDateTime(d.time)}`,
        d.committer !== d.author ? ` · committed by ${d.committer}` : '',
        d.parents.length > 1 ? ` · merge of ${d.parents.map((p) => p.slice(0, 7)).join(', ')} (files against the first parent)` : ''),
      mine ? [h('div', { class: 'group' }, 'This file'), fileRow(mine)] : null,
      mine && !others.length ? null
        : h('div', { class: 'group' }, mine ? count(others.length, 'other file') : count(d.files.length, 'file')),
      others.map(fileRow),
    );
  }
}
