//! trash.rs — Trash / Recycle Bin operations.
//!
//! r29 P2.2 Stage 2: Extracted from main.rs.
//! Declared as `pub mod trash;` in main.rs with `pub use trash::*;`.

use std::path::Path;

use crate::{
    copy_recursive_r42, ensure_xdg_trash, remove_recursive_r42, xdg_trash_files_dir,
    xdg_trash_info_dir,
};

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TrashItem {
    pub name: String,
    pub trash_path: String,
    pub original_path: String,
    pub deleted_at: Option<u64>,
    pub size: Option<u64>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TrashConflict {
    pub trash_path: String,
    pub original_path: String,
}
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct RestoreInstruction {
    pub path: String,
    pub resolution: String,
}

#[tauri::command]
pub fn trash_items(paths: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    ensure_xdg_trash()?;
    let now_str = {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let (s, m, h) = (secs % 60, (secs / 60) % 60, (secs / 3600) % 24);
        let days = secs / 86400;
        let z = days + 719468;
        let era = z / 146097;
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let mo = if mp < 10 { mp + 3 } else { mp - 9 };
        let yr = if mo <= 2 { y + 1 } else { y };
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", yr, mo, d, h, m, s)
    };
    for src_str in &paths {
        let src = Path::new(src_str);
        if !src.exists() {
            continue;
        }
        let file_name = src
            .file_name()
            .ok_or_else(|| format!("invalid path: {src_str}"))?
            .to_string_lossy()
            .to_string();
        let mut dest_name = file_name.clone();
        let mut dest = xdg_trash_files_dir().join(&dest_name);
        let mut n = 1u32;
        while dest.exists() {
            dest_name = format!("{file_name}.{n}");
            dest = xdg_trash_files_dir().join(&dest_name);
            n += 1;
        }
        let info_path = xdg_trash_info_dir().join(format!("{dest_name}.trashinfo"));
        let mut f = std::fs::File::create(&info_path).map_err(|e| format!("trashinfo: {e}"))?;
        f.write_all(format!("[Trash Info]\nPath={src_str}\nDeletionDate={now_str}\n").as_bytes())
            .map_err(|e| e.to_string())?;
        if let Err(e) = std::fs::rename(src, &dest) {
            if e.raw_os_error() == Some(18) {
                copy_recursive_r42(src, &dest)?;
                remove_recursive_r42(src)?;
            } else {
                let _ = std::fs::remove_file(&info_path);
                return Err(format!("trash move: {e}"));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn trash_list() -> Result<Vec<TrashItem>, String> {
    ensure_xdg_trash()?;
    let mut items = Vec::new();
    for entry in std::fs::read_dir(xdg_trash_info_dir())
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let info_path = entry.path();
        if info_path.extension().and_then(|e| e.to_str()) != Some("trashinfo") {
            continue;
        }
        let content = std::fs::read_to_string(&info_path).unwrap_or_default();
        let original_path = content
            .lines()
            .find(|l| l.starts_with("Path="))
            .map(|l| l[5..].to_string())
            .unwrap_or_default();
        let stem = info_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let trash_path = xdg_trash_files_dir().join(&stem);
        let size = if trash_path.is_file() {
            trash_path.metadata().ok().map(|m| m.len())
        } else {
            None
        };
        items.push(TrashItem {
            name: stem,
            trash_path: trash_path.to_string_lossy().to_string(),
            original_path,
            deleted_at: None,
            size,
        });
    }
    Ok(items)
}

#[tauri::command]
pub fn trash_item_count() -> Result<usize, String> {
    ensure_xdg_trash()?;
    Ok(std::fs::read_dir(xdg_trash_info_dir())
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("trashinfo"))
        .count())
}

#[tauri::command]
pub fn check_trash_restore_conflicts(paths: Vec<String>) -> Result<Vec<TrashConflict>, String> {
    let mut conflicts = Vec::new();
    for tp in &paths {
        let stem = Path::new(tp)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let content =
            std::fs::read_to_string(xdg_trash_info_dir().join(format!("{stem}.trashinfo")))
                .unwrap_or_default();
        let orig = content
            .lines()
            .find(|l| l.starts_with("Path="))
            .map(|l| l[5..].to_string())
            .unwrap_or_default();
        if !orig.is_empty() && Path::new(&orig).exists() {
            conflicts.push(TrashConflict {
                trash_path: tp.clone(),
                original_path: orig,
            });
        }
    }
    Ok(conflicts)
}

#[tauri::command]
pub fn trash_restore_with_resolution(instructions: Vec<RestoreInstruction>) -> Result<(), String> {
    for inst in &instructions {
        if inst.resolution == "skip" {
            continue;
        }
        let tp = Path::new(&inst.path);
        let stem = tp
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let info_path = xdg_trash_info_dir().join(format!("{stem}.trashinfo"));
        let content = std::fs::read_to_string(&info_path).map_err(|e| format!("trashinfo: {e}"))?;
        let orig = content
            .lines()
            .find(|l| l.starts_with("Path="))
            .map(|l| l[5..].to_string())
            .ok_or("bad trashinfo")?;
        let dest = match inst.resolution.as_str() {
            "keep_both" => {
                let p = Path::new(&orig);
                let par = p.parent().unwrap_or(Path::new("/"));
                let sn = p.file_stem().unwrap_or_default().to_string_lossy();
                let ext = p
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default();
                let mut c = par.join(format!("{sn} (restored){ext}"));
                let mut n = 2u32;
                while c.exists() {
                    c = par.join(format!("{sn} (restored {n}){ext}"));
                    n += 1;
                }
                c.to_string_lossy().to_string()
            }
            _ => {
                if Path::new(&orig).exists() {
                    let _ = remove_recursive_r42(Path::new(&orig));
                }
                orig.clone()
            }
        };
        let dp = Path::new(&dest);
        if let Some(par) = dp.parent() {
            std::fs::create_dir_all(par).map_err(|e| e.to_string())?;
        }
        std::fs::rename(tp, dp).or_else(|e| {
            if e.raw_os_error() == Some(18) {
                copy_recursive_r42(tp, dp)?;
                remove_recursive_r42(tp)
            } else {
                Err(format!("restore: {e}"))
            }
        })?;
        let _ = std::fs::remove_file(&info_path);
    }
    Ok(())
}
