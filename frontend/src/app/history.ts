// A repo's history: the commit log (loading more as it scrolls) and the selected commit's details.
// Clicking a file in a commit opens its diff against the commit's first parent.

import { basename, dirname, fill, h, relativeTime } from './dom';
import type { Git } from './git';
import type { Commit, CommitDetails, DiffTarget, Repo } from './model';

const PAGE = 200;

export class HistoryPanel {
  readonly el = h('section', { class: 'history' });
  private header = h('header', { class: 'diff-header' });
  private commits = h('div', { class: 'commits' });
  private details = h('div', { class: 'commit-details' });
  private repo: Repo | null = null;
  private loaded = 0;
  private done = false;
  private loading = false;
  private selected: string | null = null;

  constructor(
    private git: Git,
    private openDiff: (target: DiffTarget, repo: Repo) => void,
    private repoName: (r: Repo) => string,
  ) {
    this.el.append(this.header, h('div', { class: 'history-body' }, this.commits, this.details));
    this.commits.addEventListener('scroll', () => {
      const c = this.commits;
      if (c.scrollTop + c.clientHeight > c.scrollHeight - 400) this.more();
    });
  }

  async show(repo: Repo): Promise<void> {
    if (this.repo?.root !== repo.root) {
      this.repo = repo;
      this.loaded = 0;
      this.done = false;
      this.selected = null;
      this.commits.replaceChildren();
      this.details.replaceChildren(h('div', { class: 'empty dim' }, 'Select a commit.'));
    }
    this.header.replaceChildren(h('div', { class: 'diff-title' }, h('span', { class: 'diff-name' }, this.repoName(repo)),
      h('span', { class: 'dim' }, ' history')));
    if (this.loaded === 0) await this.more();
  }

  /** Reloads from the top, after a commit. */
  async refresh(repo: Repo): Promise<void> {
    if (this.repo?.root !== repo.root) return;
    this.repo = null;
    await this.show(repo);
  }

  private async more(): Promise<void> {
    if (!this.repo || this.done || this.loading) return;
    this.loading = true;
    const repo = this.repo;
    try {
      const page = await this.git.log(repo.root, this.loaded, PAGE);
      if (repo !== this.repo) return;
      this.loaded += page.length;
      this.done = page.length < PAGE;
      this.commits.append(...page.map((c) => this.row(c)));
      if (this.loaded === 0) this.commits.append(h('div', { class: 'empty dim' }, 'No commits yet.'));
    } finally {
      this.loading = false;
    }
  }

  private row(c: Commit): HTMLElement {
    const el = h('div', { class: 'commit', 'data-hash': c.hash, onclick: () => this.select(c.hash, el) },
      h('div', { class: 'subject' }, c.subject),
      h('div', { class: 'meta dim' }, `${c.hash.slice(0, 7)} · ${c.author} · ${relativeTime(c.time)}`));
    if (c.hash === this.selected) el.classList.add('selected');
    return el;
  }

  private async select(hash: string, el: HTMLElement): Promise<void> {
    if (!this.repo) return;
    this.selected = hash;
    for (const s of this.commits.querySelectorAll('.commit.selected')) s.classList.remove('selected');
    el.classList.add('selected');
    const repo = this.repo;
    const d = await this.git.details(repo.root, hash);
    if (repo !== this.repo || this.selected !== hash) return;
    this.renderDetails(repo, d);
  }

  private renderDetails(repo: Repo, d: CommitDetails): void {
    const [subject, ...body] = d.message.split('\n');
    const parent = d.parents[0];
    fill(this.details,
      h('div', { class: 'subject big' }, subject),
      body.join('\n').trim() ? h('pre', { class: 'body' }, body.join('\n').trim()) : null,
      h('div', { class: 'meta dim' },
        `${d.hash.slice(0, 10)} · ${d.author} <${d.email}> · ${new Date(d.time * 1000).toLocaleString()}`,
        d.committer !== d.author ? ` · committed by ${d.committer}` : '',
        d.parents.length > 1 ? ` · merge of ${d.parents.map((p) => p.slice(0, 7)).join(', ')} (files against the first parent)` : ''),
      h('div', { class: 'group' }, `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed`),
      d.files.map((f) => h('div', {
        class: `file st-${f.status}`, title: f.path,
        onclick: () => this.openDiff({
          repo: repo.root, kind: 'commit', path: f.path, hash: d.hash,
          left: f.status === 'A' || !parent ? null : { rev: parent, path: f.origPath ?? f.path },
          right: f.status === 'D' ? null : { rev: d.hash, path: f.path },
        }, repo),
      }, h('span', { class: 'letter' }, f.status), h('span', { class: 'fname' }, basename(f.path)),
      h('span', { class: 'fdir dim' }, dirname(f.path)))),
    );
  }
}
