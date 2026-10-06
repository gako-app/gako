//! The project-wide symbol index: definitions found with tree-sitter's tag queries, by name.
//!
//! PLAN.md's honest limit applies: this resolves by name, not by binding. It's built in the
//! background when a workspace opens and kept current from the watcher's change events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use serde::Serialize;
use tree_sitter::Language;
use tree_sitter_tags::{TagsConfiguration, TagsContext};

const MAX_FILE: u64 = 1 << 20;

struct Lang {
    exts: &'static [&'static str],
    config: TagsConfiguration,
}

fn config(language: Language, tags: &str) -> Option<TagsConfiguration> {
    match TagsConfiguration::new(language, tags, "") {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!("gako-core: a tag query didn't load: {e}");
            None
        }
    }
}

/// The languages with a grammar and a tag query, built once.
fn langs() -> &'static [Lang] {
    static LANGS: OnceLock<Vec<Lang>> = OnceLock::new();
    LANGS.get_or_init(|| {
        let mut v = Vec::new();
        let mut add = |exts: &'static [&'static str], lang: Language, tags: &str| {
            if let Some(config) = config(lang, tags) {
                v.push(Lang { exts, config });
            }
        };
        add(&["rs"], tree_sitter_rust::LANGUAGE.into(), tree_sitter_rust::TAGS_QUERY);
        add(&["ts", "mts", "cts"], tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), &ts_tags());
        add(&["tsx"], tree_sitter_typescript::LANGUAGE_TSX.into(), &ts_tags());
        add(&["js", "mjs", "cjs", "jsx"], tree_sitter_javascript::LANGUAGE.into(), tree_sitter_javascript::TAGS_QUERY);
        add(&["py", "pyi"], tree_sitter_python::LANGUAGE.into(), tree_sitter_python::TAGS_QUERY);
        add(&["go"], tree_sitter_go::LANGUAGE.into(), tree_sitter_go::TAGS_QUERY);
        add(&["java"], tree_sitter_java::LANGUAGE.into(), tree_sitter_java::TAGS_QUERY);
        add(&["c", "h"], tree_sitter_c::LANGUAGE.into(), tree_sitter_c::TAGS_QUERY);
        add(&["cc", "cpp", "cxx", "hpp", "hh", "hxx"], tree_sitter_cpp::LANGUAGE.into(), tree_sitter_cpp::TAGS_QUERY);
        add(&["rb"], tree_sitter_ruby::LANGUAGE.into(), tree_sitter_ruby::TAGS_QUERY);
        add(&["cs"], tree_sitter_c_sharp::LANGUAGE.into(), &cs_tags());
        add(&["php"], tree_sitter_php::LANGUAGE_PHP.into(), tree_sitter_php::TAGS_QUERY);
        v
    })
}

/// C#'s query repeats its namespace pattern with a bare `@module` capture, which tree-sitter-tags
/// rejects; the `@definition.module` line before it already covers namespaces.
fn cs_tags() -> String {
    tree_sitter_c_sharp::TAGS_QUERY.replace("(namespace_declaration name: (identifier) @name) @module\n", "")
}

/// TypeScript's tag query covers what TypeScript adds; JavaScript's covers the rest.
fn ts_tags() -> String {
    format!("{}\n{}", tree_sitter_javascript::TAGS_QUERY, tree_sitter_typescript::TAGS_QUERY)
}

fn lang_for(path: &Path) -> Option<&'static Lang> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    langs().iter().find(|l| l.exts.contains(&ext.as_str()))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    /// What the tag query calls it: function, method, class, interface, module, type, …
    pub kind: String,
    pub path: PathBuf,
    /// 1-based line, and column in UTF-16 units from the line's start (as Monaco counts).
    pub line: usize,
    pub column: usize,
    /// The definition's first line, trimmed, for lists.
    pub text: String,
}

/// Definitions in one file's source.
pub fn parse(path: &Path, source: &[u8]) -> Vec<Symbol> {
    let Some(lang) = lang_for(path) else { return Vec::new() };
    thread_local! {
        static CONTEXT: std::cell::RefCell<TagsContext> = std::cell::RefCell::new(TagsContext::new());
    }
    CONTEXT.with(|ctx| {
        let mut ctx = ctx.borrow_mut();
        let Ok((tags, _)) = ctx.generate_tags(&lang.config, source, None) else { return Vec::new() };
        tags.flatten()
            .filter(|t| t.is_definition)
            .filter_map(|t| {
                let name = std::str::from_utf8(&source[t.name_range.clone()]).ok()?.to_string();
                let line_text = std::str::from_utf8(&source[t.line_range.clone()]).unwrap_or("");
                let col_bytes = t.name_range.start.saturating_sub(t.line_range.start);
                let column = line_text.get(..col_bytes).map(|s| s.encode_utf16().count()).unwrap_or(0);
                Some(Symbol {
                    name,
                    kind: lang.config.syntax_type_name(t.syntax_type_id).to_string(),
                    path: path.to_path_buf(),
                    line: t.span.start.row + 1,
                    column: column + 1,
                    text: line_text.trim().chars().take(160).collect(),
                })
            })
            .collect()
    })
}

/// A file's definitions, with the modification time they were read at.
type FileEntry = (SystemTime, Vec<Symbol>);

#[derive(Default)]
pub struct Index {
    files: HashMap<PathBuf, FileEntry>,
}

fn modified(path: &Path) -> Option<SystemTime> {
    let m = std::fs::metadata(path).ok()?;
    (m.is_file() && m.len() <= MAX_FILE).then(|| m.modified().ok()).flatten()
}

fn parse_file(path: &Path) -> Option<FileEntry> {
    let time = modified(path)?;
    let source = std::fs::read(path).ok()?;
    Some((time, parse(path, &source)))
}

impl Index {
    /// Indexes `files` (those in a supported language), in parallel.
    pub fn build(files: &[PathBuf]) -> Index {
        let todo: Vec<&PathBuf> = files.iter().filter(|p| lang_for(p).is_some()).collect();
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
        let chunk = todo.len().div_ceil(threads).max(1);
        let parts: Vec<Vec<(PathBuf, FileEntry)>> = std::thread::scope(|s| {
            todo.chunks(chunk)
                .map(|part| s.spawn(move || part.iter().filter_map(|p| Some(((*p).clone(), parse_file(p)?))).collect()))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|h| h.join().unwrap_or_default())
                .collect()
        });
        Index { files: parts.into_iter().flatten().collect() }
    }

    /// Re-reads the supported files in `dirs` that changed, and forgets those that went away.
    /// `keep` decides which files belong (ignored files and other workspaces' files don't).
    pub fn update(&mut self, dirs: &[PathBuf], keep: &dyn Fn(&Path) -> bool) -> usize {
        let mut changed = 0;
        for dir in dirs {
            self.files.retain(|p, _| !(p.parent() == Some(dir.as_path()) && !p.exists()));
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if lang_for(&p).is_none() || !keep(&p) {
                    continue;
                }
                let Some(time) = modified(&p) else { continue };
                if self.files.get(&p).is_some_and(|(t, _)| *t == time) {
                    continue;
                }
                if let Some(entry) = parse_file(&p) {
                    self.files.insert(p, entry);
                    changed += 1;
                }
            }
        }
        changed
    }

    pub fn counts(&self) -> (usize, usize) {
        (self.files.len(), self.files.values().map(|(_, s)| s.len()).sum())
    }

    /// Definitions named `name`: in the same file first, then in the same repo (`repo`), then the
    /// rest, by path.
    pub fn definitions(&self, name: &str, from: Option<&Path>, repo: Option<&Path>) -> Vec<Symbol> {
        let mut found: Vec<&Symbol> = self.files.values().flat_map(|(_, s)| s).filter(|s| s.name == name).collect();
        let rank = |s: &Symbol| {
            if from.is_some_and(|f| s.path == f) {
                0
            } else if repo.is_some_and(|r| s.path.starts_with(r)) {
                1
            } else {
                2
            }
        };
        found.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.path.cmp(&b.path)).then(a.line.cmp(&b.line)));
        found.into_iter().take(200).cloned().collect()
    }

    /// Go to symbol: fuzzy over names, best first.
    pub fn search(&self, query: &str, limit: usize) -> Vec<(Symbol, Vec<usize>)> {
        let q: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
        if q.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<(i64, &Symbol, Vec<usize>)> = self
            .files
            .values()
            .flat_map(|(_, s)| s)
            .filter_map(|s| {
                let (score, positions) = crate::search::fuzzy_score(&s.name, &q)?;
                Some((score, s, positions))
            })
            .collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.len().cmp(&b.1.name.len())).then_with(|| a.1.path.cmp(&b.1.path)));
        hits.into_iter().take(limit).map(|(_, s, p)| (s.clone(), p)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(path: &str, src: &str) -> Vec<(String, String, usize)> {
        parse(Path::new(path), src.as_bytes()).into_iter().map(|s| (s.name, s.kind, s.line)).collect()
    }

    #[test]
    fn every_tag_query_loads() {
        let exts: Vec<&str> = langs().iter().flat_map(|l| l.exts.iter().copied()).collect();
        for ext in ["rs", "ts", "tsx", "js", "py", "go", "java", "c", "cpp", "rb", "cs", "php"] {
            assert!(exts.contains(&ext), "no tag query for .{ext}");
        }
    }

    #[test]
    fn definitions_in_several_languages() {
        assert!(names("a.rs", "struct Handler;\nfn serve() {}\nimpl Handler { fn handle(&self) {} }\n")
            .iter()
            .any(|(n, k, l)| n == "serve" && k == "function" && *l == 2));
        let ts = names("a.ts", "export interface Order { id: string }\nexport class Store {\n  find() {}\n}\nexport function load() {}\n");
        for want in ["Order", "Store", "find", "load"] {
            assert!(ts.iter().any(|(n, _, _)| n == want), "{want} in {ts:?}");
        }
        assert!(names("a.py", "class Cart:\n    def total(self):\n        pass\n").iter().any(|(n, _, _)| n == "total"));
        assert!(names("a.go", "package x\nfunc Serve() {}\ntype Server struct{}\n").iter().any(|(n, _, _)| n == "Serve"));
        assert!(names("a.cs", "namespace Shop { class Cart { void Total() {} } }\n").iter().any(|(n, _, _)| n == "Cart"));
    }

    #[test]
    fn ranking_and_updates() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("x.rs"), "fn handler() {}\n").unwrap();
        std::fs::write(b.join("y.rs"), "fn handler() {}\nfn other() {}\n").unwrap();
        let mut idx = Index::build(&[a.join("x.rs"), b.join("y.rs")]);
        let defs = idx.definitions("handler", None, Some(&b));
        assert_eq!(defs.len(), 2);
        assert!(defs[0].path.starts_with(&b), "same repo first");
        // A new definition appears after an update of its folder.
        std::fs::write(a.join("z.rs"), "fn fresh() {}\n").unwrap();
        assert_eq!(idx.update(&[a.clone()], &|_| true), 1);
        assert_eq!(idx.definitions("fresh", None, None).len(), 1);
        std::fs::remove_file(a.join("z.rs")).unwrap();
        idx.update(&[a.clone()], &|_| true);
        assert!(idx.definitions("fresh", None, None).is_empty());
        assert_eq!(idx.search("othr", 5)[0].0.name, "other");
    }
}
