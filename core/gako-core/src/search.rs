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

//! Project search with ripgrep's crates, and go-to-file.
//!
//! A scope is a set of folders to walk. Each repo is walked from its own root with its own ignore
//! rules; when one root contains another (a base repo holding nested repos), the outer walk skips
//! the inner root, which is walked as itself. That's what keeps a nested repo that the base repo
//! ignores searchable, and the base repo's results free of it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use anyhow::Result;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkState;
use ignore::overrides::OverrideBuilder;
use serde::{Deserialize, Serialize};

pub const MAX_MATCHES: usize = 20_000;
pub const MAX_FILES: usize = 10_000;
const MAX_FILESIZE: u64 = 5 << 20;
/// Text kept around a match on long lines.
const LINE_WINDOW: usize = 240;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// Globs a file must match (any of them), relative to the folder searched.
    pub include: Vec<String>,
    /// Globs that exclude a file.
    pub exclude: Vec<String>,
    pub include_ignored: bool,
}

/// Folders to walk, and repos inside them to leave out (because they're walked as roots of their
/// own, or because they're outside the scope).
#[derive(Clone, Debug, Default)]
pub struct Scope {
    pub roots: Vec<PathBuf>,
    pub skip: Vec<PathBuf>,
}

impl Scope {
    /// What the walk of `root` must not enter.
    fn inner(&self, root: &Path) -> Vec<PathBuf> {
        self.roots
            .iter()
            .chain(&self.skip)
            .filter(|r| r.as_path() != root && r.starts_with(root))
            .cloned()
            .collect()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    pub line: u64,
    pub text: String,
    /// Start and end of each match in `text`, in UTF-16 code units (what the frontend counts in).
    pub ranges: Vec<(usize, usize)>,
    /// The same matches as columns in the full line (UTF-16 units from its start), for highlighting
    /// in the file: `text` may be a window of a long line.
    pub columns: Vec<(usize, usize)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: PathBuf,
    pub matches: Vec<LineMatch>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub files: usize,
    pub matches: usize,
    pub searched: usize,
    pub limit_hit: bool,
    pub cancelled: bool,
    pub ms: f64,
    pub first_result_ms: Option<f64>,
}

fn walker(root: &Path, scope: &Scope, query: &Query) -> Result<ignore::WalkParallel> {
    let mut overrides = OverrideBuilder::new(root);
    for g in &query.include {
        overrides.add(g)?;
    }
    for g in &query.exclude {
        overrides.add(&format!("!{g}"))?;
    }
    let skip = scope.inner(root);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);
    Ok(ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(!query.include_ignored)
        .git_exclude(!query.include_ignored)
        .git_global(!query.include_ignored)
        .ignore(!query.include_ignored)
        .parents(true)
        .follow_links(false)
        .max_filesize(Some(MAX_FILESIZE))
        .overrides(overrides.build()?)
        .threads(threads)
        .filter_entry(move |e| {
            e.file_name() != ".git" && !skip.iter().any(|s| s.as_path() == e.path())
        })
        .build_parallel())
}

/// UTF-16 length of a string slice: Monaco's columns count UTF-16 code units.
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// One matching line: trimmed to a window around the first match if long, with match ranges.
fn line_match(matcher: &impl Matcher, line_no: u64, line: &str) -> LineMatch {
    let line = line.trim_end_matches(['\n', '\r']);
    let mut byte_ranges = Vec::new();
    let _ = matcher.find_iter(line.as_bytes(), |m| {
        byte_ranges.push((m.start(), m.end()));
        byte_ranges.len() < 50
    });
    let (start, end) = if line.len() > LINE_WINDOW {
        let first = byte_ranges.first().map(|r| r.0).unwrap_or(0);
        let mut s = first.saturating_sub(40);
        while !line.is_char_boundary(s) {
            s -= 1;
        }
        let mut e = (s + LINE_WINDOW).min(line.len());
        while !line.is_char_boundary(e) {
            e -= 1;
        }
        (s, e)
    } else {
        (0, line.len())
    };
    let text = &line[start..end];
    let ranges = byte_ranges
        .iter()
        .filter(|(s, e)| *s >= start && *e <= end)
        .map(|(s, e)| (utf16_len(&line[start..*s]), utf16_len(&line[start..*e])))
        .collect();
    let columns = byte_ranges
        .iter()
        .map(|(s, e)| (utf16_len(&line[..*s]), utf16_len(&line[..*e])))
        .collect();
    let prefix = if start > 0 { "…" } else { "" };
    let shift = utf16_len(prefix);
    LineMatch {
        line: line_no,
        text: format!("{prefix}{text}"),
        ranges: if shift == 0 {
            ranges
        } else {
            ranges
                .into_iter()
                .map(|(a, b)| (a + shift, b + shift))
                .collect()
        },
        columns,
    }
}

/// Searches the scope. `emit` gets batches of results as they're found (at most every 50 ms).
pub fn search(
    scope: &Scope,
    query: &Query,
    cancel: &AtomicBool,
    emit: &(dyn Fn(Vec<FileMatches>) + Sync),
) -> Result<Stats> {
    let started = Instant::now();
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!query.case_sensitive)
        .word(query.whole_word)
        .fixed_strings(!query.regex)
        .line_terminator(Some(b'\n'))
        .build(&query.pattern)?;
    let matches = AtomicUsize::new(0);
    let files = AtomicUsize::new(0);
    let searched = AtomicUsize::new(0);
    let limit_hit = AtomicBool::new(false);
    let first_result = Mutex::new(None::<f64>);
    let (tx, rx) = mpsc::channel::<FileMatches>();

    std::thread::scope(|s| -> Result<()> {
        // Batches results so the frontend gets a steady stream, not one message per file.
        s.spawn(move || {
            let mut batch = Vec::new();
            let mut last = Instant::now();
            loop {
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(f) => batch.push(f),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                if !batch.is_empty()
                    && (last.elapsed() >= Duration::from_millis(50) || batch.len() >= 200)
                {
                    emit(std::mem::take(&mut batch));
                    last = Instant::now();
                }
            }
            if !batch.is_empty() {
                emit(batch);
            }
        });
        for root in &scope.roots {
            if cancel.load(Ordering::Relaxed) || limit_hit.load(Ordering::Relaxed) {
                break;
            }
            walker(root, scope, query)?.run(|| {
                let tx = tx.clone();
                let matcher = matcher.clone();
                let mut searcher = SearcherBuilder::new()
                    .binary_detection(BinaryDetection::quit(0))
                    .line_number(true)
                    .build();
                let (matches, files, searched, limit_hit, first_result) =
                    (&matches, &files, &searched, &limit_hit, &first_result);
                Box::new(move |entry| {
                    if cancel.load(Ordering::Relaxed) || limit_hit.load(Ordering::Relaxed) {
                        return WalkState::Quit;
                    }
                    let Ok(entry) = entry else {
                        return WalkState::Continue;
                    };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        return WalkState::Continue;
                    }
                    searched.fetch_add(1, Ordering::Relaxed);
                    let mut found = Vec::new();
                    let _ = searcher.search_path(
                        &matcher,
                        entry.path(),
                        UTF8(|n, line| {
                            found.push(line_match(&matcher, n, line));
                            Ok(found.len() < 1000)
                        }),
                    );
                    if found.is_empty() {
                        return WalkState::Continue;
                    }
                    first_result
                        .lock()
                        .unwrap()
                        .get_or_insert(started.elapsed().as_secs_f64() * 1000.0);
                    let total = matches.fetch_add(found.len(), Ordering::Relaxed) + found.len();
                    let nfiles = files.fetch_add(1, Ordering::Relaxed) + 1;
                    if total >= MAX_MATCHES || nfiles >= MAX_FILES {
                        limit_hit.store(true, Ordering::Relaxed);
                    }
                    let _ = tx.send(FileMatches {
                        path: entry.into_path(),
                        matches: found,
                    });
                    WalkState::Continue
                })
            });
        }
        drop(tx);
        Ok(())
    })?;
    let first_result_ms = *first_result.lock().unwrap();
    Ok(Stats {
        files: files.into_inner(),
        matches: matches.into_inner(),
        searched: searched.into_inner(),
        limit_hit: limit_hit.into_inner(),
        cancelled: cancel.load(Ordering::Relaxed),
        ms: started.elapsed().as_secs_f64() * 1000.0,
        first_result_ms,
    })
}

/// Every file in the scope (ignored files left out), as paths relative to `base` where possible.
pub fn list_files(scope: &Scope) -> Vec<PathBuf> {
    let out = Mutex::new(Vec::new());
    for root in &scope.roots {
        let Ok(w) = walker(root, scope, &Query::default()) else {
            continue;
        };
        w.run(|| {
            let out = &out;
            Box::new(move |e| {
                if let Ok(e) = e
                    && e.file_type().is_some_and(|t| t.is_file())
                {
                    out.lock().unwrap().push(e.into_path());
                }
                WalkState::Continue
            })
        });
    }
    let mut v = out.into_inner().unwrap();
    v.sort();
    v
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: PathBuf,
    pub score: i64,
    /// Matched characters' positions in the displayed relative path (UTF-16 units).
    pub positions: Vec<usize>,
}

/// Go to file: `query`'s characters as a subsequence of the path, best matches first.
pub fn find_files(files: &[PathBuf], base: &Path, query: &str, limit: usize) -> Vec<FileHit> {
    let q: Vec<char> = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if q.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<FileHit> = files
        .iter()
        .filter_map(|p| {
            let rel = p
                .strip_prefix(base)
                .unwrap_or(p)
                .to_string_lossy()
                .replace('\\', "/");
            let (score, positions) = fuzzy_score(&rel, &q)?;
            Some(FileHit {
                path: p.clone(),
                score,
                positions,
            })
        })
        .collect();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    hits.truncate(limit);
    hits
}

/// Scores `q` as a subsequence of `path`: consecutive characters, word starts and matches in the
/// file name count for more; long paths count for a little less. Matching prefers the file name:
/// it's tried from the end first.
pub fn fuzzy_score(path: &str, q: &[char]) -> Option<(i64, Vec<usize>)> {
    let chars: Vec<char> = path.chars().collect();
    let lower: Vec<char> = chars.iter().flat_map(|c| c.to_lowercase()).collect();
    if lower.len() != chars.len() {
        return None; // case mapping changed the length; skip rather than misplace highlights
    }
    let name_start = path
        .rfind('/')
        .map(|i| path[..=i].chars().count())
        .unwrap_or(0);
    // Greedy from the right, so the file name gets the match when it can.
    let mut positions = Vec::with_capacity(q.len());
    let mut j = lower.len();
    for &qc in q.iter().rev() {
        let i = lower[..j].iter().rposition(|&c| c == qc)?;
        positions.push(i);
        j = i;
    }
    positions.reverse();
    let mut score: i64 = 0;
    for (k, &i) in positions.iter().enumerate() {
        score += 10;
        if k > 0 && positions[k - 1] + 1 == i {
            score += 15;
        }
        let prev = if i == 0 { '/' } else { chars[i - 1] };
        if matches!(prev, '/' | '_' | '-' | '.' | ' ')
            || (prev.is_lowercase() && chars[i].is_uppercase())
        {
            score += 20;
        }
        if i >= name_start {
            score += 12;
        }
    }
    score -= (chars.len() / 8) as i64;
    let positions = positions
        .iter()
        .map(|&i| chars[..i].iter().map(|c| c.len_utf16()).sum())
        .collect();
    Some((score, positions))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_init(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(dir)
                .status()
                .unwrap()
                .success()
        );
    }

    fn layout() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let base = t.path().canonicalize().unwrap();
        git_init(&base);
        std::fs::write(base.join(".gitignore"), "/services/\nbuild/\n").unwrap();
        std::fs::write(base.join("README.md"), "needle in the base\n").unwrap();
        std::fs::create_dir_all(base.join("build")).unwrap();
        std::fs::write(base.join("build/out.txt"), "needle in build output\n").unwrap();
        git_init(&base.join("services/auth"));
        std::fs::write(
            base.join("services/auth/main.rs"),
            "fn needle() {}\nlet Needle = 1;\n",
        )
        .unwrap();
        std::fs::write(base.join("services/auth/.gitignore"), "*.log\n").unwrap();
        std::fs::write(base.join("services/auth/debug.log"), "needle in a log\n").unwrap();
        (t, base)
    }

    fn run(scope: &Scope, q: Query) -> (Vec<(String, u64)>, Stats) {
        let found = Mutex::new(Vec::new());
        let stats = search(scope, &q, &AtomicBool::new(false), &|batch| {
            let mut f = found.lock().unwrap();
            for fm in batch {
                for m in fm.matches {
                    f.push((
                        fm.path.file_name().unwrap().to_string_lossy().into_owned(),
                        m.line,
                    ));
                }
            }
        })
        .unwrap();
        let mut v = found.into_inner().unwrap();
        v.sort();
        (v, stats)
    }

    #[test]
    fn scopes_and_ignore_rules() {
        let (_t, base) = layout();
        let auth = base.join("services/auth");
        let q = || Query {
            pattern: "needle".into(),
            ..Query::default()
        };
        // All: the nested repo is searched as itself, despite the base repo ignoring it.
        let (all, _) = run(
            &Scope {
                roots: vec![base.clone(), auth.clone()],
                skip: vec![],
            },
            q(),
        );
        assert_eq!(
            all,
            vec![
                ("README.md".into(), 1),
                ("main.rs".into(), 1),
                ("main.rs".into(), 2)
            ]
        );
        // The base repo only.
        let (only_base, _) = run(
            &Scope {
                roots: vec![base.clone()],
                skip: vec![auth.clone()],
            },
            q(),
        );
        assert_eq!(only_base, vec![("README.md".into(), 1)]);
        // One nested repo, case-sensitive.
        let (cs, _) = run(
            &Scope {
                roots: vec![auth.clone()],
                skip: vec![],
            },
            Query {
                case_sensitive: true,
                ..q()
            },
        );
        assert_eq!(cs, vec![("main.rs".into(), 1)]);
        // Ignored files included on request.
        let (ign, _) = run(
            &Scope {
                roots: vec![base.clone(), auth.clone()],
                skip: vec![],
            },
            Query {
                include_ignored: true,
                ..q()
            },
        );
        assert_eq!(ign.len(), 5);
        // The base repo only, with ignored files included: the nested repo still stays out.
        let (ign_base, _) = run(
            &Scope {
                roots: vec![base.clone()],
                skip: vec![auth.clone()],
            },
            Query {
                include_ignored: true,
                ..q()
            },
        );
        assert_eq!(
            ign_base,
            vec![("README.md".into(), 1), ("out.txt".into(), 1)]
        );
    }

    #[test]
    fn regex_word_and_globs() {
        let (_t, base) = layout();
        let auth = base.join("services/auth");
        let scope = Scope {
            roots: vec![base.clone(), auth],
            skip: vec![],
        };
        let (re, _) = run(
            &scope,
            Query {
                pattern: r"fn \w+\(".into(),
                regex: true,
                ..Query::default()
            },
        );
        assert_eq!(re, vec![("main.rs".into(), 1)]);
        let (word, _) = run(
            &scope,
            Query {
                pattern: "needl".into(),
                whole_word: true,
                ..Query::default()
            },
        );
        assert!(word.is_empty());
        let (globbed, _) = run(
            &scope,
            Query {
                pattern: "needle".into(),
                include: vec!["*.md".into()],
                ..Query::default()
            },
        );
        assert_eq!(globbed, vec![("README.md".into(), 1)]);
        let (excluded, _) = run(
            &scope,
            Query {
                pattern: "needle".into(),
                exclude: vec!["*.rs".into()],
                ..Query::default()
            },
        );
        assert_eq!(excluded, vec![("README.md".into(), 1)]);
    }

    #[test]
    fn match_ranges_in_utf16() {
        let m = line_match(
            &grep_regex::RegexMatcher::new("x").unwrap(),
            1,
            "日本x😀x\n",
        );
        assert_eq!(m.ranges, vec![(2, 3), (5, 6)]);
        assert_eq!(m.columns, m.ranges);
        // A long line is shown as a window around the first match; columns still count from its start.
        let long = format!("{}needle{}", "a".repeat(500), "b".repeat(500));
        let m = line_match(&grep_regex::RegexMatcher::new("needle").unwrap(), 1, &long);
        assert!(m.text.starts_with('…') && m.text.contains("needle"));
        assert_eq!(m.columns, vec![(500, 506)]);
    }

    #[test]
    fn fuzzy_prefers_file_names() {
        let base = PathBuf::from("/w");
        let files: Vec<PathBuf> = [
            "src/server/handler.rs",
            "src/home/readme.md",
            "services/auth/src/user_handler.ts",
        ]
        .iter()
        .map(|p| base.join(p))
        .collect();
        let hits = find_files(&files, &base, "handler", 10);
        assert_eq!(hits.len(), 2);
        assert!(hits[0].path.ends_with("handler.rs"));
        let hits = find_files(&files, &base, "uh", 10);
        assert!(hits[0].path.ends_with("user_handler.ts"));
    }
}
