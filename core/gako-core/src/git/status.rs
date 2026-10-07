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

//! Parses `git status --porcelain=v2 -z --branch`.
//!
//! Each record ends with NUL. Header records start with `# `; entries with `1` (changed), `2`
//! (renamed or copied, followed by a second NUL-terminated field with the original path), `u`
//! (unmerged), `?` (untracked) or `!` (ignored). The format is documented in `git help status`.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    BothDeleted,
    AddedByUs,
    DeletedByThem,
    AddedByThem,
    DeletedByUs,
    BothAdded,
    BothModified,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    /// The change between HEAD and the index (staged).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<Change>,
    /// The change between the index and the working tree (unstaged).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Change>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<Conflict>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub untracked: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub submodule: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The commit HEAD points at; none on an unborn branch.
    pub oid: Option<String>,
    /// The branch name; none when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    /// The upstream is configured but no longer exists.
    pub upstream_gone: bool,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<Entry>,
    /// Untracked files past the limit, counted but not listed.
    pub untracked_omitted: usize,
}

fn change(c: u8) -> Option<Change> {
    match c {
        b'M' => Some(Change::Modified),
        b'T' => Some(Change::TypeChanged),
        b'A' => Some(Change::Added),
        b'D' => Some(Change::Deleted),
        b'R' => Some(Change::Renamed),
        b'C' => Some(Change::Copied),
        _ => None,
    }
}

fn conflict(xy: &[u8]) -> Option<Conflict> {
    match xy {
        b"DD" => Some(Conflict::BothDeleted),
        b"AU" => Some(Conflict::AddedByUs),
        b"UD" => Some(Conflict::DeletedByThem),
        b"UA" => Some(Conflict::AddedByThem),
        b"DU" => Some(Conflict::DeletedByUs),
        b"AA" => Some(Conflict::BothAdded),
        b"UU" => Some(Conflict::BothModified),
        _ => None,
    }
}

/// `nfields` space-separated fields, the last of which (the path) may itself contain spaces.
fn fields(record: &str, nfields: usize) -> Option<Vec<&str>> {
    let v: Vec<&str> = record.splitn(nfields, ' ').collect();
    (v.len() == nfields).then_some(v)
}

pub fn parse(out: &[u8], untracked_limit: usize) -> Status {
    let text = String::from_utf8_lossy(out);
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    let mut st = Status::default();
    let mut saw_ab = false;
    let mut untracked = 0usize;

    while let Some(rec) = records.next() {
        if let Some(header) = rec.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => st.oid = Some(value.to_string()),
                "branch.head" if value != "(detached)" => st.branch = Some(value.to_string()),
                "branch.upstream" => st.upstream = Some(value.to_string()),
                "branch.ab" => {
                    saw_ab = true;
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = rec.as_bytes()[0];
        let entry = match kind {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            b'1' => fields(rec, 9).map(|f| Entry {
                path: f[8].to_string(),
                index: change(f[1].as_bytes()[0]),
                worktree: change(f[1].as_bytes()[1]),
                submodule: f[2].starts_with('S'),
                ..Entry::default()
            }),
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>, then <origPath>
            b'2' => fields(rec, 10).map(|f| Entry {
                path: f[9].to_string(),
                orig_path: records.next().map(str::to_string),
                index: change(f[1].as_bytes()[0]),
                worktree: change(f[1].as_bytes()[1]),
                submodule: f[2].starts_with('S'),
                ..Entry::default()
            }),
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            b'u' => fields(rec, 11).map(|f| Entry {
                path: f[10].to_string(),
                conflict: conflict(f[1].as_bytes()),
                submodule: f[2].starts_with('S'),
                ..Entry::default()
            }),
            b'?' => {
                untracked += 1;
                if untracked > untracked_limit {
                    st.untracked_omitted += 1;
                    None
                } else {
                    Some(Entry {
                        path: rec[2..].to_string(),
                        untracked: true,
                        ..Entry::default()
                    })
                }
            }
            _ => None,
        };
        if let Some(e) = entry {
            st.entries.push(e);
        }
    }
    st.upstream_gone = st.upstream.is_some() && !saw_ab;
    st
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(records: &[&str]) -> Vec<u8> {
        records
            .iter()
            .flat_map(|r| r.bytes().chain(std::iter::once(0)))
            .collect()
    }

    const H: &str = "100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222";

    #[test]
    fn branch_headers() {
        let st = parse(
            &z(&[
                "# branch.oid abc123",
                "# branch.head main",
                "# branch.upstream origin/main",
                "# branch.ab +2 -3",
            ]),
            10,
        );
        assert_eq!(st.oid.as_deref(), Some("abc123"));
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind, st.upstream_gone), (2, 3, false));
    }

    #[test]
    fn unborn_detached_and_gone() {
        let unborn = parse(&z(&["# branch.oid (initial)", "# branch.head main"]), 10);
        assert_eq!((unborn.oid, unborn.branch.as_deref()), (None, Some("main")));
        let detached = parse(&z(&["# branch.oid abc", "# branch.head (detached)"]), 10);
        assert_eq!(detached.branch, None);
        let gone = parse(
            &z(&[
                "# branch.oid abc",
                "# branch.head main",
                "# branch.upstream origin/old",
            ]),
            10,
        );
        assert!(gone.upstream_gone);
    }

    #[test]
    fn changed_renamed_and_spaces() {
        let st = parse(
            &z(&[
                &format!("1 M. N... {H} src/a file.ts"),
                &format!("1 .D N... {H} gone.ts"),
                &format!("1 AM N... {H} new.ts"),
                &format!("2 R. N... {H} R100 renamed to.ts"),
                "renamed from.ts",
                &format!("1 .M SC.. {H} vendor/lib"),
            ]),
            10,
        );
        assert_eq!(st.entries.len(), 5);
        assert_eq!(st.entries[0].path, "src/a file.ts");
        assert_eq!(
            (st.entries[0].index, st.entries[0].worktree),
            (Some(Change::Modified), None)
        );
        assert_eq!(st.entries[1].worktree, Some(Change::Deleted));
        assert_eq!(
            (st.entries[2].index, st.entries[2].worktree),
            (Some(Change::Added), Some(Change::Modified))
        );
        assert_eq!(st.entries[3].path, "renamed to.ts");
        assert_eq!(st.entries[3].orig_path.as_deref(), Some("renamed from.ts"));
        assert_eq!(st.entries[3].index, Some(Change::Renamed));
        assert!(st.entries[4].submodule);
    }

    #[test]
    fn conflicts() {
        let u = "100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333";
        let st = parse(
            &z(&[
                &format!("u UU N... {u} both.ts"),
                &format!("u DU N... {u} deleted by us.ts"),
            ]),
            10,
        );
        assert_eq!(st.entries[0].conflict, Some(Conflict::BothModified));
        assert_eq!(st.entries[1].conflict, Some(Conflict::DeletedByUs));
        assert_eq!(st.entries[1].path, "deleted by us.ts");
    }

    #[test]
    fn untracked_limit() {
        let st = parse(&z(&["? a", "? b", "? c", "! ignored"]), 2);
        assert_eq!(st.entries.iter().filter(|e| e.untracked).count(), 2);
        assert_eq!(st.untracked_omitted, 1);
    }
}
