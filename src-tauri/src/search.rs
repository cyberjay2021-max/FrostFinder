//! search.rs — File search: deep search, in-memory index, advanced search.
//!
//! r29 P2.2 Stage 3: Extracted from main.rs.

use crate::build_file_entry;
use crate::FileEntry;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::UNIX_EPOCH;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeepSearchResult {
    pub entries: Vec<FileEntry>,
    pub searched: u64,
    pub truncated: bool,
}

// ── Phase 7: In-memory search index ──────────────────────────────────────────
// Built at startup by index_home_dir(); kept in sync by the inotify watcher.
// Each entry: (lowercase_name, full_path, is_dir, size, modified_secs)
#[derive(Debug, Clone)]
pub struct IndexEntry {
    name_lc: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexSearchResult {
    path: String,
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResultV2 {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub snippet: Option<String>,
}

static SEARCH_INDEX: std::sync::OnceLock<RwLock<Vec<IndexEntry>>> = std::sync::OnceLock::new();

pub fn search_index_store() -> &'static RwLock<Vec<IndexEntry>> {
    SEARCH_INDEX.get_or_init(|| RwLock::new(Vec::new()))
}

#[tauri::command]
pub fn deep_search(
    root: String,
    query: String,
    include_hidden: bool,
    max_results: usize,
) -> DeepSearchResult {
    use rayon::prelude::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let q = query.to_lowercase();
    let max = max_results.min(5000);
    let truncated = Arc::new(AtomicBool::new(false));

    // Collect top-level subdirectories for parallel dispatch.
    // Include hidden dirs only when include_hidden is set.
    let root_path = Path::new(&root);
    let mut top_dirs: Vec<PathBuf> = vec![root_path.to_path_buf()];
    if let Ok(rd) = fs::read_dir(root_path) {
        for entry in rd.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_dir() && (include_hidden || !name.starts_with('.')) {
                top_dirs.push(entry.path());
            }
        }
    }

    // Each rayon worker collects into its own Vec — no Mutex contention during search.
    // We merge all vecs once at the end.
    let per_dir: Vec<(Vec<FileEntry>, u64)> = top_dirs
        .par_iter()
        .map(|dir| {
            if truncated.load(Ordering::Relaxed) {
                return (vec![], 0);
            }
            let mut local: Vec<FileEntry> = Vec::new();
            let mut local_searched: u64 = 0;
            deep_search_dir(
                dir,
                &q,
                include_hidden,
                max,
                &mut local,
                &mut local_searched,
                &truncated,
            );
            (local, local_searched)
        })
        .collect();

    let mut entries: Vec<FileEntry> = Vec::new();
    let mut total_searched: u64 = 0;
    for (mut v, s) in per_dir {
        total_searched += s;
        if entries.len() < max {
            let remaining = max - entries.len();
            v.truncate(remaining);
            entries.extend(v);
        }
    }
    let was_truncated = truncated.load(Ordering::Relaxed) || entries.len() >= max;
    entries.truncate(max);
    // Sort by name for deterministic results (JS will not re-sort)
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    DeepSearchResult {
        entries,
        searched: total_searched,
        truncated: was_truncated,
    }
}

fn deep_search_dir(
    dir: &Path,
    q: &str,
    include_hidden: bool,
    max: usize,
    results: &mut Vec<FileEntry>,
    searched: &mut u64,
    truncated: &std::sync::atomic::AtomicBool,
) {
    if truncated.load(std::sync::atomic::Ordering::Relaxed) || results.len() >= max {
        return;
    }
    let ps = dir.to_string_lossy();
    if ps.starts_with("/proc") || ps.starts_with("/sys") || ps.starts_with("/dev") {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.filter_map(|e| e.ok()) {
        if results.len() >= max {
            truncated.store(true, std::sync::atomic::Ordering::Relaxed);
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        *searched += 1;
        if name.to_lowercase().contains(q) {
            if let Some(fe) = build_file_entry(&entry.path()) {
                results.push(fe);
            }
        }
        if entry.path().is_dir()
            && !fs::symlink_metadata(entry.path())
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
        {
            deep_search_dir(
                &entry.path(),
                q,
                include_hidden,
                max,
                results,
                searched,
                truncated,
            );
        }
    }
}

// ── p7: In-memory filename index ─────────────────────────────────────────────
// Walk the home directory once at startup, populate SEARCH_INDEX.
// The inotify dir-changed events keep it current by calling index_apply_event().
// Only filenames are indexed — content search still uses search_advanced / deep_search.

pub fn index_home_dir() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let mut entries: Vec<IndexEntry> = Vec::with_capacity(50_000);
    index_walk(&home, &mut entries, 0);
    *search_index_store()
        .write()
        .unwrap_or_else(|e| e.into_inner()) = entries;
}

fn index_walk(dir: &Path, out: &mut Vec<IndexEntry>, depth: u8) {
    if depth > 12 {
        return;
    }
    let ps = dir.to_string_lossy();
    if ps.starts_with("/proc") || ps.starts_with("/sys") || ps.starts_with("/dev") {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.filter_map(|x| x.ok()) {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(IndexEntry {
            name_lc: name.to_lowercase(),
            path: path.to_string_lossy().into_owned(),
            is_dir,
            size,
            modified,
        });
        if is_dir && !meta.file_type().is_symlink() {
            index_walk(&path, out, depth + 1);
        }
    }
}

/// Called from the inotify watcher when a directory changes: re-index that dir only.
pub fn index_apply_event(changed_dir: &str) {
    let dir = Path::new(changed_dir);
    let prefix = format!("{}/", changed_dir.trim_end_matches('/'));
    // Remove stale entries for the changed directory
    {
        let mut idx = search_index_store()
            .write()
            .unwrap_or_else(|e| e.into_inner());
        idx.retain(|e| {
            // Keep entries NOT under changed_dir and NOT directly in it
            !e.path.starts_with(&prefix) && e.path != changed_dir
        });
    }
    // Re-add entries (shallow — just top level of changed dir)
    let mut fresh: Vec<IndexEntry> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.filter_map(|x| x.ok()) {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            let is_dir = meta.is_dir();
            let size = if is_dir { 0 } else { meta.len() };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            fresh.push(IndexEntry {
                name_lc: name.to_lowercase(),
                path: path.to_string_lossy().into_owned(),
                is_dir,
                size,
                modified,
            });
        }
    }
    search_index_store()
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .extend(fresh);
}

/// Fast filename-only search against the in-memory index.
/// Falls back gracefully to an empty Vec if the index is not yet ready.
#[tauri::command]
pub fn search_index_query(query: String, max_results: usize) -> Vec<IndexSearchResult> {
    let q = query.to_lowercase();
    let max = max_results.min(2000);
    let idx = search_index_store()
        .read()
        .unwrap_or_else(|e| e.into_inner());
    let mut results: Vec<IndexSearchResult> = idx
        .iter()
        .filter(|e| e.name_lc.contains(&q))
        .take(max)
        .map(|e| {
            let name = Path::new(&e.path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            IndexSearchResult {
                path: e.path.clone(),
                name,
                is_dir: e.is_dir,
                size: e.size,
                modified: e.modified,
            }
        })
        .collect();
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    results
}

#[tauri::command]
pub fn search_files(
    roots: Vec<String>,
    query: String,
    include_hidden: bool,
    max_results: usize,
) -> crate::SearchResult {
    let q = query.to_lowercase();
    let max = max_results.min(2000);
    let mut results = Vec::new();
    let mut total_searched: u64 = 0;
    let mut truncated = false;
    for root in &roots {
        search_recursive(
            Path::new(root),
            &q,
            include_hidden,
            max,
            &mut results,
            &mut total_searched,
            &mut truncated,
        );
        if truncated {
            break;
        }
    }
    crate::SearchResult {
        entries: results,
        total_searched,
        truncated,
    }
}
fn search_recursive(
    dir: &Path,
    q: &str,
    include_hidden: bool,
    max: usize,
    results: &mut Vec<FileEntry>,
    searched: &mut u64,
    truncated: &mut bool,
) {
    if results.len() >= max {
        *truncated = true;
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.filter_map(|e| e.ok()) {
        if results.len() >= max {
            *truncated = true;
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        *searched += 1;
        if name.to_lowercase().contains(q) {
            if let Some(fe) = build_file_entry(&entry.path()) {
                results.push(fe);
            }
        }
        let sym_meta = fs::symlink_metadata(entry.path());
        let is_symlink = sym_meta
            .as_ref()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let is_dir = entry.path().is_dir();
        if is_dir && !is_symlink {
            let p = entry.path();
            let ps = p.to_string_lossy();
            if ps.starts_with("/proc") || ps.starts_with("/sys") || ps.starts_with("/dev") {
                continue;
            }
            search_recursive(&p, q, include_hidden, max, results, searched, truncated);
        }
    }
}

#[tauri::command]
pub fn search_advanced(
    query: String,
    root_path: String,
    recursive: bool,
    use_regex: bool,
    search_contents: bool,
    include_hidden: bool,
    size_op: Option<String>,
    date_op: Option<String>,
) -> Result<Vec<SearchResultV2>, String> {
    let pattern: Box<dyn Fn(&str) -> bool + Send> = if use_regex {
        let re = regex::Regex::new(&query).map_err(|e| format!("regex: {e}"))?;
        Box::new(move |s: &str| re.is_match(s))
    } else {
        let lower = query.to_lowercase();
        Box::new(move |s: &str| s.to_lowercase().contains(&lower))
    };

    // Parse size filter
    let size_filter: Option<Box<dyn Fn(u64) -> bool + Send>> = size_op.as_ref().map(|op| {
        let bytes: u64 = match op.as_str() {
            "lt1kb" => 1024,
            "lt10kb" => 10 * 1024,
            "lt100kb" => 100 * 1024,
            "lt1mb" => 1024 * 1024,
            "lt10mb" => 10 * 1024 * 1024,
            "lt100mb" => 100 * 1024 * 1024,
            "gt1kb" => 1024,
            "gt10kb" => 10 * 1024,
            "gt100kb" => 100 * 1024,
            "gt1mb" => 1024 * 1024,
            "gt10mb" => 10 * 1024 * 1024,
            "gt100mb" => 100 * 1024 * 1024,
            "gt1gb" => 1024 * 1024 * 1024,
            _ => 0,
        };
        let is_lt = op.starts_with("lt");
        Box::new(
            move |size: u64| {
                if is_lt {
                    size < bytes
                } else {
                    size > bytes
                }
            },
        ) as Box<dyn Fn(u64) -> bool + Send>
    });

    // Parse date filter
    let now = std::time::SystemTime::now();
    let date_filter: Option<Box<dyn Fn(i64) -> bool + Send>> = date_op.as_ref().map(|op| {
        let secs_per_day: i64 = 86400;
        let days_ago = match op.as_str() {
            "today" => 0,
            "yesterday" => 1,
            "thisweek" => 7,
            "thismonth" => 30,
            "thisyear" => 365,
            "older1y" => 365,
            "older6m" => 180,
            "older30d" => 30,
            _ => 0,
        };
        let is_older = op.starts_with("older");
        let cutoff = now.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
            - (days_ago * secs_per_day);
        Box::new(move |modified: i64| {
            if is_older {
                modified < cutoff
            } else {
                modified >= cutoff
            }
        }) as Box<dyn Fn(i64) -> bool + Send>
    });

    fn walk(
        dir: &Path,
        rec: bool,
        hidden: bool,
        contents: bool,
        pat: &dyn Fn(&str) -> bool,
        q: &str,
        out: &mut Vec<SearchResultV2>,
        depth: u32,
        visited: &mut std::collections::HashSet<u64>,
        size_filter: &Option<Box<dyn Fn(u64) -> bool + Send>>,
        date_filter: &Option<Box<dyn Fn(i64) -> bool + Send>>,
    ) {
        if out.len() >= 500 || depth > 20 {
            return;
        }
        // p9: inode-cycle guard — skip directories whose inode we have already visited
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if let Ok(m) = std::fs::symlink_metadata(dir) {
                if !visited.insert(m.ino()) {
                    return;
                }
            }
        }
        let rd = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        for entry in rd.flatten() {
            if out.len() >= 500 {
                break;
            }
            let path = entry.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if !hidden && name.starts_with('.') {
                continue;
            }
            // p9: skip symlinks to avoid traversing loops
            let sym_meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if sym_meta.file_type().is_symlink() {
                continue;
            }
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let size = meta.len();
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let snippet = if contents && !is_dir && size < 10 * 1024 * 1024 {
                std::fs::read_to_string(&path).ok().and_then(|txt| {
                    let lq = q.to_lowercase();
                    txt.lines()
                        .find(|l| l.to_lowercase().contains(&lq))
                        .map(|l| {
                            if l.len() > 120 {
                                l[..120].to_string()
                            } else {
                                l.trim().to_string()
                            }
                        })
                })
            } else {
                None
            };
            let matches_name = pat(&name) || snippet.is_some();
            let matches_size = size_filter.as_ref().map_or(true, |f| f(size));
            let matches_date = date_filter.as_ref().map_or(true, |f| f(modified as i64));
            if matches_name && matches_size && matches_date {
                out.push(SearchResultV2 {
                    path: path.to_string_lossy().to_string(),
                    name,
                    is_dir,
                    size,
                    modified,
                    snippet,
                });
            }
            if rec && is_dir {
                walk(
                    &path,
                    rec,
                    hidden,
                    contents,
                    pat,
                    q,
                    out,
                    depth + 1,
                    visited,
                    size_filter,
                    date_filter,
                );
            }
        }
    }
    let mut results = Vec::new();
    let mut visited = std::collections::HashSet::new();
    walk(
        Path::new(&root_path),
        recursive,
        include_hidden,
        search_contents,
        pattern.as_ref(),
        &query,
        &mut results,
        0,
        &mut visited,
        &size_filter,
        &date_filter,
    );
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(results)
}
