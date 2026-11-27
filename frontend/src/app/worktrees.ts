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

// Where each repo goes in the Repositories view: worktrees under their main repo (see docs/git.md).

export interface FamilyRepo {
  root: string;
  kind: 'normal' | 'worktree' | 'submodule';
  /** A worktree's main repo, by its root, when the core lists it too. */
  main?: string;
}

export interface Placed<R> {
  repo: R;
  /** A worktree right under its main repo, drawn indented. */
  nested: boolean;
  /** A main repo with nothing of its own to show, there for a worktree under it: just its header. */
  parentOnly: boolean;
  /** A worktree away from its main repo (one is changed, the other clean): named with the main repo's
   * name, so it's still clear whose it is. */
  apart: boolean;
}

/**
 * Splits `repos` (in the core's order, by path) into the changed ones, with their files, and the
 * clean ones, keeping each main repo and its worktrees together: a changed worktree brings its main
 * repo's header into the changed part, even when the main repo is clean. `listed` says whether a
 * repo has something to show (changes, commits to pull or push, an error); `scanned`, whether it
 * has a status yet. With `cleanWorktrees` off, worktrees with nothing to show are left out.
 */
export function arrange<R extends FamilyRepo>(
  repos: R[],
  listed: (r: R) => boolean,
  scanned: (r: R) => boolean,
  cleanWorktrees: boolean,
): { changed: Placed<R>[]; clean: Placed<R>[] } {
  const roots = new Set(repos.map((r) => r.root));
  const mainOf = (r: R) => (r.kind === 'worktree' && r.main && r.main !== r.root && roots.has(r.main) ? r.main : null);
  const kids = new Map<string, R[]>();
  for (const r of repos) {
    const m = mainOf(r);
    if (m) kids.set(m, [...(kids.get(m) ?? []), r]);
  }
  const place = (repo: R, nested = false, parentOnly = false, apart = false): Placed<R> => ({ repo, nested, parentOnly, apart });
  const changed: Placed<R>[] = [];
  const clean: Placed<R>[] = [];
  const keepClean = (r: R) => !listed(r) && scanned(r) && (cleanWorktrees || r.kind !== 'worktree');
  for (const top of repos.filter((r) => !mainOf(r))) {
    const family = kids.get(top.root) ?? [];
    const changedKids = family.filter(listed);
    const topListed = listed(top);
    if (topListed || changedKids.length) {
      changed.push(place(top, false, !topListed));
      for (const k of changedKids) changed.push(place(k, true));
    } else if (keepClean(top)) {
      clean.push(place(top));
    }
    // The main repo is in the clean part only when nothing of its family is in the changed part.
    const topInClean = !topListed && !changedKids.length && keepClean(top);
    for (const k of family.filter(keepClean)) clean.push(place(k, topInClean, false, !topInClean));
  }
  return { changed, clean };
}

/** The last part of a path, on any platform. */
function last(path: string, parts = 1): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-parts).join('/');
}

/** A worktree's name under its main repo: its folder's name, or the last two parts of its path when
 * the folder is named like the main repo (as agent tools name theirs: `…/worktrees/a1b2/app`). */
export function worktreeName(root: string, main: string): string {
  return last(root) === last(main) ? last(root, 2) : last(root);
}
