//! tags.rs — All tag storage: xattr, SQLite (v2), JSON fallback (v1 legacy), colour store.
//!
//! r28 P2.2 Stage 1: Extracted from main.rs.
//! This module is declared as `pub mod tags;` in main.rs and re-exported via
//! `pub use tags::*;` so all existing callers compile unchanged.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

// ── v1 JSON tag store (legacy read path, kept for migration) ──────────────────

pub fn tags_db_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("frostfinder")
        .join("tags.json")
}

pub fn load_tags_db() -> serde_json::Value {
    let p = tags_db_path();
    if let Ok(s) = std::fs::read_to_string(&p) {
        serde_json::from_str(&s).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    }
}

pub fn save_tags_db(db: &serde_json::Value) {
    let p = tags_db_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(p, db.to_string());
}

// ── Tag colour store (JSON, being migrated to SQLite tag_colors table) ────────

pub fn tag_colors_db_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("frostfinder")
        .join("tag_colors.json")
}

pub fn load_tag_colors() -> serde_json::Value {
    let p = tag_colors_db_path();
    if let Ok(s) = std::fs::read_to_string(&p) {
        serde_json::from_str(&s).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    }
}

pub fn save_tag_colors(db: &serde_json::Value) {
    let p = tag_colors_db_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(p, db.to_string());
}

// ── v2 SQLite tag store ───────────────────────────────────────────────────────

pub fn tag_db() -> &'static std::sync::Mutex<rusqlite::Connection> {
    static TAG_DB: std::sync::OnceLock<std::sync::Mutex<rusqlite::Connection>> =
        std::sync::OnceLock::new();
    TAG_DB.get_or_init(|| {
        let db_path = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("frostfinder/tags.db");
        if let Some(p) = db_path.parent() {
            let _ = std::fs::create_dir_all(p);
        }

        let conn = 'open: {
            if let Ok(c) = rusqlite::Connection::open(&db_path) {
                let ok: bool = c
                    .query_row("PRAGMA integrity_check", [], |r| {
                        Ok(r.get::<_, String>(0).unwrap_or_default() == "ok")
                    })
                    .unwrap_or(false);
                if ok {
                    break 'open c;
                }
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let backup = db_path.with_extension(format!("db.corrupt.{}", ts));
                let _ = std::fs::rename(&db_path, &backup);
                eprintln!("[frostfinder] tags.db corrupt — backed up to {:?}", backup);
            }
            rusqlite::Connection::open(&db_path).expect("tag db open")
        };

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS file_tags(\
               path TEXT PRIMARY KEY, tags_json TEXT NOT NULL DEFAULT '[]'); \
             CREATE TABLE IF NOT EXISTS tag_colors(\
               tag TEXT PRIMARY KEY, color TEXT NOT NULL DEFAULT '#60a5fa'); \
             PRAGMA journal_mode=WAL;",
        )
        .expect("tag db init");

        std::sync::Mutex::new(conn)
    })
}

static TAG_DB_WRITE_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub fn tag_db_maybe_checkpoint() {
    let n = TAG_DB_WRITE_COUNT.fetch_add(1, Ordering::Relaxed);
    if n % 500 == 499 {
        let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
        let _ = db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    }
}

// ── xattr helpers (platform-conditional) ─────────────────────────────────────

const XATTR_KEY_R42: &str = "user.frostfinder.tags";

#[cfg(not(target_os = "windows"))]
pub fn xattr_read_tags(path: &str) -> Option<Vec<String>> {
    let raw = xattr::get(path, XATTR_KEY_R42).ok()??;
    serde_json::from_slice(&raw).ok()
}
#[cfg(target_os = "windows")]
pub fn xattr_read_tags(_path: &str) -> Option<Vec<String>> {
    None
}

#[cfg(not(target_os = "windows"))]
pub fn xattr_write_tags(path: &str, tags: &[String]) -> bool {
    let json = serde_json::to_vec(tags).unwrap_or_default();
    xattr::set(path, XATTR_KEY_R42, &json).is_ok()
}
#[cfg(target_os = "windows")]
pub fn xattr_write_tags(_path: &str, _tags: &[String]) -> bool {
    false
}

pub fn db_read_tags(path: &str) -> Vec<String> {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    db.query_row(
        "SELECT tags_json FROM file_tags WHERE path=?1",
        rusqlite::params![path],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|j| serde_json::from_str(&j).ok())
    .unwrap_or_default()
}

pub fn db_write_tags(path: &str, tags: &[String]) {
    let json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".into());
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let _ = db.execute(
        "INSERT INTO file_tags(path,tags_json) VALUES(?1,?2) \
         ON CONFLICT(path) DO UPDATE SET tags_json=excluded.tags_json",
        rusqlite::params![path, json],
    );
    tag_db_maybe_checkpoint();
}

// ── Structs ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileTag {
    pub path: String,
    pub tags: Vec<String>,
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_tag_palette() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"name":"red",    "color":"#f87171"}),
        serde_json::json!({"name":"orange", "color":"#fb923c"}),
        serde_json::json!({"name":"yellow", "color":"#fbbf24"}),
        serde_json::json!({"name":"green",  "color":"#34d399"}),
        serde_json::json!({"name":"blue",   "color":"#60a5fa"}),
        serde_json::json!({"name":"purple", "color":"#a78bfa"}),
        serde_json::json!({"name":"pink",   "color":"#f472b6"}),
        serde_json::json!({"name":"gray",   "color":"#94a3b8"}),
    ]
}

#[tauri::command]
pub fn set_tag_color(tag: String, color: String) -> Result<(), String> {
    let mut db = load_tag_colors();
    db.as_object_mut()
        .ok_or("DB corrupt")?
        .insert(tag, serde_json::Value::String(color));
    save_tag_colors(&db);
    Ok(())
}

#[tauri::command]
pub fn get_tags_with_colors() -> Vec<serde_json::Value> {
    let tags_db = load_tags_db();
    let colors_db = load_tag_colors();
    let mut tag_set = std::collections::HashSet::new();
    if let Some(obj) = tags_db.as_object() {
        for v in obj.values() {
            if let Some(arr) = v.as_array() {
                for t in arr {
                    if let Some(s) = t.as_str() {
                        tag_set.insert(s.to_string());
                    }
                }
            }
        }
    }
    let mut result: Vec<_> = tag_set
        .into_iter()
        .map(|tag| {
            let color = colors_db
                .get(&tag)
                .and_then(|v| v.as_str())
                .unwrap_or("#60a5fa")
                .to_string();
            serde_json::json!({"name": tag, "color": color})
        })
        .collect();
    result.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    result
}

#[tauri::command]
pub fn get_tags_with_colors_v2() -> Vec<serde_json::Value> {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let mut tag_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let mut stmt = match db.prepare("SELECT tags_json FROM file_tags") {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map([], |row| row.get::<_, String>(0));
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                if let Ok(tags) = serde_json::from_str::<Vec<String>>(&row) {
                    for t in tags {
                        tag_set.insert(t);
                    }
                }
            }
        }
    }
    let json_db = load_tags_db();
    if let Some(obj) = json_db.as_object() {
        for v in obj.values() {
            if let Some(arr) = v.as_array() {
                for t in arr {
                    if let Some(s) = t.as_str() {
                        tag_set.insert(s.to_string());
                    }
                }
            }
        }
    }
    let mut result: Vec<_> = tag_set
        .into_iter()
        .map(|tag| {
            let color: String = db
                .query_row(
                    "SELECT color FROM tag_colors WHERE tag=?1",
                    rusqlite::params![tag],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| "#60a5fa".to_string());
            serde_json::json!({"name": tag, "color": color})
        })
        .collect();
    result.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    result
}

#[tauri::command]
pub fn set_tag_color_v2(tag: String, color: String) -> Result<(), String> {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    db.execute(
        "INSERT INTO tag_colors(tag, color) VALUES(?1,?2) \
         ON CONFLICT(tag) DO UPDATE SET color=excluded.color",
        rusqlite::params![tag, color],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_all_tags_v2() -> Vec<String> {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let mut tag_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut stmt = match db.prepare("SELECT tags_json FROM file_tags") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = stmt.query_map([], |row| row.get::<_, String>(0));
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(&row) {
                for t in tags {
                    tag_set.insert(t);
                }
            }
        }
    }
    let mut v: Vec<_> = tag_set.into_iter().collect();
    v.sort();
    v
}

#[tauri::command]
pub fn migrate_tags_to_sqlite() -> Result<usize, String> {
    let json_db = load_tags_db();
    let colors_db = load_tag_colors();
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let mut migrated = 0usize;
    if let Some(obj) = json_db.as_object() {
        for (path, tags_val) in obj {
            if let Some(arr) = tags_val.as_array() {
                let tags: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                if tags.is_empty() {
                    continue;
                }
                let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
                if db
                    .execute(
                        "INSERT OR IGNORE INTO file_tags(path, tags_json) VALUES(?1, ?2)",
                        rusqlite::params![path, tags_json],
                    )
                    .is_ok()
                {
                    migrated += 1;
                }
            }
        }
    }
    if let Some(obj) = colors_db.as_object() {
        for (tag, color_val) in obj {
            if let Some(color) = color_val.as_str() {
                let _ = db.execute(
                    "INSERT INTO tag_colors(tag, color) VALUES(?1,?2) \
                     ON CONFLICT(tag) DO UPDATE SET color=excluded.color",
                    rusqlite::params![tag, color],
                );
            }
        }
    }
    Ok(migrated)
}

#[tauri::command]
pub fn get_file_tags(path: String) -> Vec<String> {
    let db = load_tags_db();
    db.get(&path)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_file_tags(path: String, tags: Vec<String>) -> Result<(), String> {
    let mut db = load_tags_db();
    let obj = db.as_object_mut().ok_or("DB corrupt")?;
    if tags.is_empty() {
        obj.remove(&path);
    } else {
        obj.insert(
            path,
            serde_json::Value::Array(tags.into_iter().map(serde_json::Value::String).collect()),
        );
    }
    save_tags_db(&db);
    Ok(())
}

#[tauri::command]
pub fn get_all_tags() -> Vec<String> {
    let db = load_tags_db();
    let mut tags = std::collections::HashSet::new();
    if let Some(obj) = db.as_object() {
        for v in obj.values() {
            if let Some(arr) = v.as_array() {
                for t in arr {
                    if let Some(s) = t.as_str() {
                        tags.insert(s.to_string());
                    }
                }
            }
        }
    }
    let mut v: Vec<_> = tags.into_iter().collect();
    v.sort();
    v
}

#[tauri::command]
pub fn search_by_tag(tag: String) -> Vec<FileTag> {
    let db = load_tags_db();
    let mut results = Vec::new();
    if let Some(obj) = db.as_object() {
        for (path, v) in obj {
            if let Some(arr) = v.as_array() {
                let tags: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                if tags.iter().any(|t| t == &tag) {
                    results.push(FileTag {
                        path: path.clone(),
                        tags,
                    });
                }
            }
        }
    }
    results
}

#[tauri::command]
pub fn get_file_tags_v2(path: String) -> Vec<String> {
    if let Some(t) = xattr_read_tags(&path) {
        if !t.is_empty() {
            return t;
        }
    }
    db_read_tags(&path)
}

#[tauri::command]
pub fn set_file_tags_v2(path: String, tags: Vec<String>) -> Result<(), String> {
    db_write_tags(&path, &tags);
    xattr_write_tags(&path, &tags);
    Ok(())
}

#[tauri::command]
pub fn migrate_tag_path(old_path: String, new_path: String) -> Result<(), String> {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let _ = db.execute(
        "UPDATE file_tags SET path=?2 WHERE path=?1",
        rusqlite::params![old_path, new_path],
    );
    Ok(())
}

#[tauri::command]
pub fn audit_tag_db() -> Vec<String> {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = match db.prepare("SELECT path FROM file_tags") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let paths = stmt.query_map([], |row| row.get::<_, String>(0));
    let Ok(paths) = paths else {
        return vec![];
    };
    paths.flatten().filter(|p| !Path::new(p).exists()).collect()
}

#[tauri::command]
pub fn cleanup_tag_db() -> Result<usize, String> {
    let orphans = audit_tag_db();
    if orphans.is_empty() {
        return Ok(0);
    }
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let mut removed = 0usize;
    for path in &orphans {
        if db
            .execute(
                "DELETE FROM file_tags WHERE path=?1",
                rusqlite::params![path],
            )
            .is_ok()
        {
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn tag_db_stats() -> serde_json::Value {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let total: i64 = db
        .query_row("SELECT COUNT(*) FROM file_tags", [], |r| r.get(0))
        .unwrap_or(0);
    let orphans = audit_tag_db().len() as i64;
    serde_json::json!({ "total": total, "orphans": orphans })
}

/// r30 P2.3 cleanup: search_by_tag backed by SQLite file_tags table.
#[tauri::command]
pub fn search_by_tag_v2(tag: String) -> Vec<FileTag> {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = match db.prepare("SELECT path, tags_json FROM file_tags") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    });
    let Ok(rows) = rows else {
        return vec![];
    };
    rows.flatten()
        .filter_map(|(path, tags_json)| {
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            if tags.iter().any(|t| t == &tag) {
                Some(FileTag { path, tags })
            } else {
                None
            }
        })
        .collect()
}

/// Scan a directory for files with xattr tags and import them to SQLite.
/// This helps migrate tags that were only stored in xattr before the fix.
#[tauri::command]
pub fn scan_xattr_tags(path: String) -> Result<usize, String> {
    let mut imported = 0usize;
    let root = Path::new(&path);

    fn scan_dir(dir: &Path, imported: &mut usize) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, imported);
                } else if path.is_file() {
                    if let Some(tags) = xattr_read_tags(path.to_str().unwrap_or("")) {
                        if !tags.is_empty() {
                            db_write_tags(path.to_str().unwrap_or(""), &tags);
                            *imported += 1;
                        }
                    }
                }
            }
        }
    }

    scan_dir(root, &mut imported);
    Ok(imported)
}
