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

// Groups in the agent bar, as order: the bar keeps its terminals in one list, and a group's members
// sit next to each other in it. These keep them so as entries move, join and leave groups.

/** Something in a group, or not. */
export interface Member<G> {
  group: G | null;
}

/** Moves `unit` (entries next to each other in `list`, a lone entry or a group's) to `to` among
 * `units`, the units of the list shown that it's one of: before the unit it now precedes there, or
 * after the last. */
export function moveUnit<T>(list: T[], units: T[][], unit: T[], to: number): void {
  const rest = units.filter((u) => u !== unit);
  for (const t of unit) list.splice(list.indexOf(t), 1);
  const at = to < rest.length ? list.indexOf(rest[to][0])
    : rest.length ? list.indexOf(rest[rest.length - 1].at(-1)!) + 1
      : list.length;
  list.splice(at, 0, ...unit);
}

/** The entries of `list` cut into units: each lone entry, and each group's run of members. */
export function unitsOf<G, T extends Member<G>>(list: T[]): T[][] {
  const units: T[][] = [];
  for (const t of list) {
    const last = units.at(-1);
    if (t.group && last && last[0].group === t.group) last.push(t);
    else units.push([t]);
  }
  return units;
}

/** Puts `t` into `group`, after its last member. */
export function join<G, T extends Member<G>>(list: T[], t: T, group: G): void {
  list.splice(list.indexOf(t), 1);
  const last = list.findLastIndex((x) => x.group === group);
  list.splice(last + 1, 0, t);
  t.group = group;
}

/** Takes `t` out of its group, putting it just after the group so the rest stay together. */
export function leave<G, T extends Member<G>>(list: T[], t: T): void {
  const group = t.group;
  if (!group) return;
  t.group = null;
  list.splice(list.indexOf(t), 1);
  const last = list.findLastIndex((x) => x.group === group);
  if (last >= 0) list.splice(last + 1, 0, t);
  else list.push(t);
}

/** Groups left with fewer than two members are no more; true if any was dissolved. */
export function dissolveSmall<G, T extends Member<G>>(list: T[]): boolean {
  const counts = new Map<G, number>();
  for (const t of list) if (t.group) counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
  let changed = false;
  for (const t of list) {
    if (t.group && counts.get(t.group)! < 2) {
      t.group = null;
      changed = true;
    }
  }
  return changed;
}

/** "Group N", with the lowest N none of `names` has. */
export function groupName(names: string[]): string {
  const taken = new Set(names);
  let n = 1;
  while (taken.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}
