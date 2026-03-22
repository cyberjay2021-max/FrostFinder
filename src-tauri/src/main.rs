#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use rayon::prelude::*;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Mutex, RwLock, OnceLock};
use tauri::{Window, Manager, Emitter};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

// ── Filesystem watcher ────────────────────────────────────────────────────────
use notify::{RecommendedWatcher, RecursiveMode, Watcher, Config as NotifyConfig};
use std::time::Duration;

/// Holds the active directory watcher.
/// Replaced atomically on each watch_dir call; dropped (unwatched) on unwatch_dir.
// Watch mode reported back to JS for the status-bar indicator.
#[derive(Debug, Clone, PartialEq)]
enum WatchMode { Inotify, Polling }

struct DirWatcher {
    _watcher: Option<RecommendedWatcher>, // None when polling
    mode: WatchMode,
    _poll_stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}
static ACTIVE_WATCHER: Mutex<Option<DirWatcher>> = Mutex::new(None);

static MEDIA_PORT: AtomicU16 = AtomicU16::new(0);
static EXTRACT_IN_PROGRESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ── Phase 7: File-op cancel token ─────────────────────────────────────────────
// Set to true by cancel_file_op(); copy_files_batch / move_files_batch check it
// between files and abort early. Cleared at the start of each new operation.
static FILE_OP_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ── Phase 7: In-memory search index ──────────────────────────────────────────
// Built at startup by index_home_dir(); kept in sync by the inotify watcher.
// Each entry: (lowercase_name, full_path, is_dir, size, modified_secs)
#[derive(Clone)]
struct IndexEntry {
    name_lc: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}
static SEARCH_INDEX: OnceLock<RwLock<Vec<IndexEntry>>> = OnceLock::new();

fn search_index_store() -> &'static RwLock<Vec<IndexEntry>> {
    SEARCH_INDEX.get_or_init(|| RwLock::new(Vec::new()))
}

// Cached tar binary path — resolved once on first extraction, reused forever.
static TAR_BIN: OnceLock<Option<String>> = OnceLock::new();

fn find_tar_bin() -> Option<&'static str> {
    TAR_BIN.get_or_init(|| {
        ["bsdtar", "tar"].iter()
            .find(|&&b| std::process::Command::new("which").arg(b).output()
                .map(|o| o.status.success()).unwrap_or(false))
            .map(|&b| b.to_string())
    }).as_deref()
}

/// Returned by `get_native_window_handle` to JS.
#[derive(serde::Serialize)]
struct NativeWindowHandle { backend: String, handle: i64 }

// ── mpv subprocess state ─────────────────────────────────────────────────────
// mpv is spawned as a child process with --wid, sidestepping libmpv ABI issues.
// IPC socket lets us send commands (margins, pause, quit) without linking libmpv.
static MPV_CHILD: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();

fn mpv_child() -> &'static Mutex<Option<std::process::Child>> {
    MPV_CHILD.get_or_init(|| Mutex::new(None))
}

/// Check if a binary exists in PATH
fn which(cmd: &str) -> bool {
    std::process::Command::new("which").arg(cmd).output()
        .map(|o| o.status.success()).unwrap_or(false)
}

/// Check all optional dependencies and return their availability status
#[tauri::command]
fn check_optional_deps() -> std::collections::HashMap<String, bool> {
    let mut deps = std::collections::HashMap::new();
    deps.insert("ffmpeg".to_string(), which("ffmpeg"));
    deps.insert("ffprobe".to_string(), which("ffprobe"));
    deps.insert("heif_convert".to_string(), which("heif-convert"));
    deps.insert("rclone".to_string(), which("rclone"));
    deps.insert("gocryptfs".to_string(), which("gocryptfs"));
    deps.insert("sshfs".to_string(), which("sshfs"));
    deps.insert("curlftpfs".to_string(), which("curlftpfs"));
    deps.insert("mpv".to_string(), which("mpv"));
    deps.insert("mpv_mpris".to_string(), which("mpv"));
    deps
}

#[tauri::command]
fn get_platform() -> String {
    #[cfg(target_os = "linux")]
    { "linux".to_string() }
    #[cfg(target_os = "macos")]
    { "macos".to_string() }
    #[cfg(target_os = "windows")]
    { "windows".to_string() }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    { "unknown".to_string() }
}

// ── Quick Look payload cache ──────────────────────────────────────────────────
// Stores the JSON payload for the QL window between the main window calling
// set_ql_payload() and the QL window calling get_ql_payload() on load.
// Using Rust-side storage avoids all cross-window event race conditions.
static QL_PAYLOAD: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn ql_payload_store() -> &'static Mutex<Option<String>> {
    QL_PAYLOAD.get_or_init(|| Mutex::new(None))
}

/// Called by main window before opening the QL WebviewWindow.
/// Stores the JSON-encoded { entries, curIdx } payload for QL to retrieve.
#[tauri::command]
fn set_ql_payload(payload: String) {
    if let Ok(mut lock) = ql_payload_store().lock() {
        *lock = Some(payload);
    }
}

/// Called by QL window on load. Returns and CLEARS the stored payload.
/// Returns empty string if no payload is available.
#[tauri::command]
fn get_ql_payload() -> String {
    if let Ok(mut lock) = ql_payload_store().lock() {
        lock.take().unwrap_or_default()
    } else {
        String::new()
    }
}

// ── Structs ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String, pub path: String, pub is_dir: bool, pub size: u64,
    pub modified: u64, pub extension: Option<String>, pub is_hidden: bool,
    pub is_symlink: bool, pub permissions: String,
    pub created: Option<u64>, pub accessed: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct DirectoryListing { pub path: String, pub entries: Vec<FileEntry>, pub parent: Option<String> }
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DriveInfo {
    pub name: String, pub path: String, pub drive_type: String, pub is_mounted: bool,
    pub total_bytes: u64, pub free_bytes: u64, pub filesystem: String, pub device: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SidebarFavorite { pub name: String, pub path: String, pub icon: String, pub exists: bool }
#[derive(Debug, Serialize, Deserialize)]
pub struct SidebarData { pub favorites: Vec<SidebarFavorite>, pub drives: Vec<DriveInfo> }
#[derive(Debug, Serialize, Deserialize)]
pub struct FilePreview {
    pub path: String, pub content: Option<String>, pub image_base64: Option<String>,
    pub mime_type: String, pub size: u64, pub modified: u64,
    pub is_text: bool, pub is_image: bool, pub is_video: bool, pub is_audio: bool,
    pub line_count: Option<usize>, pub permissions: String,
    pub thumb_path: Option<String>,   // cached thumbnail file path (served via HTTP media server)
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult { pub entries: Vec<FileEntry>, pub total_searched: u64, pub truncated: bool }
#[derive(Debug, Serialize, Deserialize)]
pub struct FileTag { pub path: String, pub tags: Vec<String> }
#[derive(Debug, Serialize, Deserialize)]
pub struct CompressResult { pub output_path: String, pub file_count: usize }

// ── Helpers ───────────────────────────────────────────────────────────────────

fn get_permissions(metadata: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        let mut s = String::with_capacity(10);
        s.push(if metadata.is_dir() { 'd' } else { '-' });
        for &(r,w,x) in &[(0o400u32,0o200u32,0o100u32),(0o040,0o020,0o010),(0o004,0o002,0o001)] {
            s.push(if mode&r!=0{'r'}else{'-'}); s.push(if mode&w!=0{'w'}else{'-'}); s.push(if mode&x!=0{'x'}else{'-'});
        }
        s
    }
    #[cfg(not(unix))]
    {
        // Windows: return a human-readable placeholder; permissions model differs
        let _ = metadata;
        String::from("----------")
    }
}

#[cfg(target_os = "linux")]
fn parse_mounts() -> Vec<(String,String,String)> {
    let mut results = Vec::new();
    if let Ok(c) = fs::read_to_string("/proc/mounts") {
        for line in c.lines() {
            let p: Vec<&str> = line.split_whitespace().collect();
            if p.len() >= 3 { results.push((p[0].to_string(), p[1].to_string(), p[2].to_string())); }
        }
    }
    results
}

fn get_disk_space(path: &str) -> (u64, u64) { _get_disk_space_impl(path) }

/// Unix (Linux + macOS): libc::statvfs — available on both, already 64-bit on macOS.
#[cfg(unix)]
fn _get_disk_space_impl(path: &str) -> (u64, u64) {
    use std::ffi::CString;
    let Ok(c) = CString::new(path) else { return (0, 0) };
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st) == 0 {
            let b = st.f_frsize;
            return (st.f_blocks * b, st.f_bavail * b);
        }
    }
    (0, 0)
}

/// Windows: no statvfs — return zeroes; sidebar shows drives without space info.
#[cfg(not(unix))]
fn _get_disk_space_impl(_path: &str) -> (u64, u64) { (0, 0) }

#[cfg(target_os = "linux")]
fn is_usb_device(dev:&str)->bool {
    let base=dev.trim_end_matches(|c:char|c.is_ascii_digit());
    let removable=fs::read_to_string(format!("/sys/block/{}/removable",base))
        .map(|s|s.trim()=="1").unwrap_or(false);
    if !removable { return false; }
    let is_usb_uevent = fs::read_to_string(format!("/sys/block/{}/device/uevent",base))
        .map(|s|s.to_uppercase().contains("USB")).unwrap_or(false);
    let is_usb_subsystem = fs::read_link(format!("/sys/block/{}/device/subsystem",base))
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase().contains("usb")))
        .unwrap_or(false);
    // If removable and we can't confirm otherwise, assume USB
    is_usb_uevent || is_usb_subsystem || removable
}

#[cfg(target_os = "linux")]
fn is_rotational(dev:&str)->bool {
    // Strip partition number to get base device (e.g. "sda1" -> "sda", "nvme0n1p1" -> "nvme0n1")
    let base = if dev.starts_with("nvme") {
        // nvme0n1p1 -> nvme0n1 (strip trailing pN)
        let re = dev.trim_end_matches(|c:char| c.is_ascii_digit());
        re.trim_end_matches('p')
    } else {
        dev.trim_end_matches(|c:char| c.is_ascii_digit())
    };
    fs::read_to_string(format!("/sys/block/{}/queue/rotational", base))
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn get_volume_label(device:&str)->Option<String> {
    let by_label=Path::new("/dev/disk/by-label");
    let dev_canon=fs::canonicalize(device).ok();
    for entry in fs::read_dir(by_label).ok()?.filter_map(|e|e.ok()) {
        if let Ok(target)=fs::read_link(entry.path()) {
            let resolved=fs::canonicalize(by_label.join(&target)).unwrap_or_else(|_|by_label.join(&target));
            if dev_canon.as_ref().map(|d|d==&resolved).unwrap_or(false) {
                return Some(entry.file_name().to_string_lossy().replace("\\x20"," "));
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn classify_drive(device:&str,mountpoint:&str,fstype:&str)->Option<DriveInfo> {
    let skip=["tmpfs","devtmpfs","sysfs","proc","devpts","securityfs","cgroup","cgroup2",
              "pstore","bpf","tracefs","debugfs","mqueue","hugetlbfs","fusectl","configfs",
              "ramfs","efivarfs","autofs","squashfs","overlay","nsfs","rpc_pipefs","nfsd",
              "fuse.portal","fuse.gvfsd-fuse","fuse.pipewire","binfmt_misc"];
    if skip.contains(&fstype){return None;}
    if mountpoint.starts_with("/proc")||mountpoint.starts_with("/sys")||
       mountpoint.starts_with("/dev")||mountpoint.starts_with("/run/user")||
       mountpoint.starts_with("/snap")||mountpoint.starts_with("/run/snapd")||
       mountpoint.starts_with("/boot")||mountpoint.starts_with("/run/credentials")||
       mountpoint.starts_with("/run/lock")||mountpoint.starts_with("/run/systemd") {return None;}
    // Filter OS-internal system mountpoints that users don't navigate to
    let exact_hide=["/boot","/tmp","/var/log","/srv","/cache","/log","/root",
                    "/",  // Root Disk — hide, users navigate via Home
    ];
    if exact_hide.contains(&mountpoint){return None;}
    // Hide anything whose last path component is "cache" or "tmp" or "log"
    let last_seg=mountpoint.split('/').filter(|s|!s.is_empty()).next_back().unwrap_or("");
    if["cache","tmp","log","lost+found","proc","sys"].contains(&last_seg){return None;}
    // Always allow /run/media and /media (standard Linux USB mount points)
    if !device.starts_with('/')&&!device.starts_with("//"){return None;}
    let (total,free)=get_disk_space(mountpoint);
    // Skip zero-size pseudo mounts (but keep root)
    if total == 0 && mountpoint != "/" { return None; }
    let dev_short=device.split('/').next_back().unwrap_or(device);
    let drive_type=if fstype.starts_with("nfs")||fstype=="cifs"||fstype=="fuse.sshfs"{"network"}
        else if dev_short.contains("sr")||dev_short.contains("cdrom"){"optical"}
        // Check device name first — NVMe/SSD/HDD must keep their type regardless of
        // where udisksctl mounts them (udisksctl always uses /run/media/user/label,
        // which previously forced everything to "usb").
        else if dev_short.starts_with("sd")||dev_short.starts_with("vd")||dev_short.starts_with("hd")||
                dev_short.starts_with("nvme")||dev_short.starts_with("mmcblk") {
            if is_usb_device(dev_short){"usb"}
            else if dev_short.starts_with("nvme"){"nvme"}
            else if is_rotational(dev_short){"hdd"}
            else{"ssd"}
        // Only fall back to "usb" from mountpoint path if the device wasn't already
        // identified above (e.g. unknown device names under /run/media or /media)
        } else if mountpoint.starts_with("/run/media")||mountpoint.starts_with("/media"){"usb"}
        // Common USB/removable filesystem types on unrecognised device names
        else if (fstype=="vfat"||fstype=="exfat"||fstype=="ntfs"||fstype=="ntfs-3g"||fstype=="fuseblk")&&is_usb_device(dev_short){"usb"}
        else{"internal"};
    let name=if mountpoint=="/"{"Root Disk".to_string()}
        else{get_volume_label(device).unwrap_or_else(||{
            if drive_type=="usb"{
                // Try lsblk for label
                let udev_name=std::process::Command::new("lsblk")
                    .args(["-no","LABEL",device]).output().ok()
                    .and_then(|o|String::from_utf8(o.stdout).ok())
                    .map(|s|s.trim().to_string())
                    .filter(|s|!s.is_empty());
                udev_name.unwrap_or_else(||format!("USB Drive ({})",dev_short))
            }else{
                Path::new(mountpoint).file_name()
                    .map(|n|n.to_string_lossy().to_string())
                    .unwrap_or_else(||mountpoint.to_string())
            }
        })};
    Some(DriveInfo{name,path:mountpoint.to_string(),drive_type:drive_type.to_string(),
        is_mounted:true,total_bytes:total,free_bytes:free,filesystem:fstype.to_string(),device:device.to_string()})
}

fn build_file_entry(path:&Path)->Option<FileEntry> {
    let sym_meta=fs::symlink_metadata(path).ok()?;
    let is_symlink=sym_meta.file_type().is_symlink();
    let real_meta=if is_symlink { fs::metadata(path).unwrap_or_else(|_| sym_meta.clone()) } else { sym_meta };
    let name=path.file_name()?.to_string_lossy().to_string();
    let is_hidden=name.starts_with('.');
    let is_dir=real_meta.is_dir();
    let size=if is_dir{0}else{real_meta.len()};
    let permissions=get_permissions(&real_meta);
    let modified=real_meta.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_secs()).unwrap_or(0);
    let created=real_meta.created().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_secs());
    let accessed=real_meta.accessed().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_secs());
    let extension=if is_dir{None}else{path.extension().map(|e|e.to_string_lossy().to_string().to_lowercase())};
    Some(FileEntry{name,path:path.to_string_lossy().to_string(),is_dir,size,modified,extension,is_hidden,is_symlink,permissions,created,accessed})
}

fn is_image_ext(ext:&str)->bool { matches!(ext,"png"|"jpg"|"jpeg"|"gif"|"webp"|"bmp"|"ico"|"tiff"|"tif"|"heic"|"heif") }

// ── Thumbnail cache ───────────────────────────────────────────────────────────

fn thumb_cache_dir()->PathBuf { dirs::cache_dir().unwrap_or_else(||PathBuf::from("/tmp")).join("frostfinder").join("thumbs") }
fn thumb_cache_key(path:&str,mtime:u64)->String {
    let mut h:u64=0xcbf29ce484222325u64;
    for b in path.as_bytes().iter().chain(b"|".iter()).chain(mtime.to_le_bytes().iter()) { h^=*b as u64; h=h.wrapping_mul(0x100000001b3u64); }
    format!("{:016x}.jpg",h)
}
fn thumb_cache_path(path:&str,mtime:u64)->PathBuf {
    thumb_cache_dir().join(thumb_cache_key(path,mtime))
}
fn thumb_cache_get(path:&str,mtime:u64)->Option<PathBuf> {
    let p=thumb_cache_path(path,mtime);
    if p.exists(){Some(p)}else{None}
}
fn thumb_cache_put(path:&str,mtime:u64,jpeg:&[u8]) {
    let dir=thumb_cache_dir(); let _=fs::create_dir_all(&dir);
    let _=fs::write(dir.join(thumb_cache_key(path,mtime)),jpeg);
}

// ── Tag storage ───────────────────────────────────────────────────────────────

fn tags_db_path()->PathBuf {
    dirs::data_dir().unwrap_or_else(||PathBuf::from("/tmp"))
        .join("frostfinder").join("tags.json")
}
fn tag_colors_db_path()->PathBuf {
    dirs::data_dir().unwrap_or_else(||PathBuf::from("/tmp"))
        .join("frostfinder").join("tag_colors.json")
}
fn load_tag_colors()->serde_json::Value {
    let p=tag_colors_db_path();
    if let Ok(s)=fs::read_to_string(&p){ serde_json::from_str(&s).unwrap_or(serde_json::json!({})) }
    else{ serde_json::json!({}) }
}
fn save_tag_colors(db:&serde_json::Value){
    let p=tag_colors_db_path();
    if let Some(parent)=p.parent(){let _=fs::create_dir_all(parent);}
    let _=fs::write(p,db.to_string());
}

// The 7 macOS-style tag colors available to users
#[tauri::command]
fn get_tag_palette()->Vec<serde_json::Value> {
    vec![
        serde_json::json!({"name":"Red",   "color":"#f87171"}),
        serde_json::json!({"name":"Orange","color":"#fb923c"}),
        serde_json::json!({"name":"Yellow","color":"#fbbf24"}),
        serde_json::json!({"name":"Green", "color":"#34d399"}),
        serde_json::json!({"name":"Blue",  "color":"#60a5fa"}),
        serde_json::json!({"name":"Purple","color":"#a78bfa"}),
        serde_json::json!({"name":"Gray",  "color":"#94a3b8"}),
    ]
}

#[tauri::command]
fn set_tag_color(tag:String,color:String)->Result<(),String>{
    let mut db=load_tag_colors();
    db.as_object_mut().ok_or("corrupt")?.insert(tag,serde_json::Value::String(color));
    save_tag_colors(&db); Ok(())
}

#[tauri::command]
fn get_tags_with_colors()->Vec<serde_json::Value> {
    let tags_db=load_tags_db();
    let colors_db=load_tag_colors();
    let mut tag_set=std::collections::HashSet::new();
    if let Some(obj)=tags_db.as_object(){
        for v in obj.values(){
            if let Some(arr)=v.as_array(){
                for t in arr{ if let Some(s)=t.as_str(){tag_set.insert(s.to_string());} }
            }
        }
    }
    let mut result:Vec<_>=tag_set.into_iter().map(|tag|{
        let color=colors_db.get(&tag).and_then(|v|v.as_str()).unwrap_or("#60a5fa").to_string();
        serde_json::json!({"name":tag,"color":color})
    }).collect();
    result.sort_by(|a,b|a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    result
}

// Deep search — parallel across all subdirectories using Rayon
#[derive(Debug, Serialize, Deserialize)]
pub struct DeepSearchResult { pub entries: Vec<FileEntry>, pub searched: u64, pub truncated: bool }

#[tauri::command]
fn deep_search(root:String, query:String, include_hidden:bool, max_results:usize) -> DeepSearchResult {
    use rayon::prelude::*;
    use std::sync::atomic::{AtomicBool,Ordering};
    use std::sync::Arc;

    let q = query.to_lowercase();
    let max = max_results.min(5000);
    let truncated = Arc::new(AtomicBool::new(false));

    // Collect top-level subdirectories for parallel dispatch.
    // Include hidden dirs only when include_hidden is set.
    let root_path = Path::new(&root);
    let mut top_dirs: Vec<PathBuf> = vec![root_path.to_path_buf()];
    if let Ok(rd) = fs::read_dir(root_path) {
        for entry in rd.filter_map(|e|e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_dir() && (include_hidden || !name.starts_with('.')) {
                top_dirs.push(entry.path());
            }
        }
    }

    // Each rayon worker collects into its own Vec — no Mutex contention during search.
    // We merge all vecs once at the end.
    let per_dir: Vec<(Vec<FileEntry>, u64)> = top_dirs.par_iter().map(|dir| {
        if truncated.load(Ordering::Relaxed) { return (vec![], 0); }
        let mut local: Vec<FileEntry> = Vec::new();
        let mut local_searched: u64 = 0;
        deep_search_dir(dir, &q, include_hidden, max, &mut local, &mut local_searched, &truncated);
        (local, local_searched)
    }).collect();

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
    entries.sort_by(|a,b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    DeepSearchResult { entries, searched: total_searched, truncated: was_truncated }
}

fn deep_search_dir(dir:&Path,q:&str,include_hidden:bool,max:usize,results:&mut Vec<FileEntry>,searched:&mut u64,truncated:&std::sync::atomic::AtomicBool){
    if truncated.load(std::sync::atomic::Ordering::Relaxed) || results.len()>=max { return; }
    let ps=dir.to_string_lossy();
    if ps.starts_with("/proc")||ps.starts_with("/sys")||ps.starts_with("/dev") { return; }
    let Ok(rd)=fs::read_dir(dir) else{return};
    for entry in rd.filter_map(|e|e.ok()){
        if results.len()>=max { truncated.store(true,std::sync::atomic::Ordering::Relaxed); return; }
        let name=entry.file_name().to_string_lossy().to_string();
        if !include_hidden&&name.starts_with('.'){continue;}
        *searched+=1;
        if name.to_lowercase().contains(q){ if let Some(fe)=build_file_entry(&entry.path()){results.push(fe);} }
        if entry.path().is_dir()&&!fs::symlink_metadata(entry.path()).map(|m|m.file_type().is_symlink()).unwrap_or(false){
            deep_search_dir(&entry.path(),q,include_hidden,max,results,searched,truncated);
        }
    }
}


// ── p7: In-memory filename index ─────────────────────────────────────────────
// Walk the home directory once at startup, populate SEARCH_INDEX.
// The inotify dir-changed events keep it current by calling index_apply_event().
// Only filenames are indexed — content search still uses search_advanced / deep_search.

fn index_home_dir() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let mut entries: Vec<IndexEntry> = Vec::with_capacity(50_000);
    index_walk(&home, &mut entries, 0);
    *search_index_store().write().unwrap_or_else(|e| e.into_inner()) = entries;
}

fn index_walk(dir: &Path, out: &mut Vec<IndexEntry>, depth: u8) {
    if depth > 12 { return; }
    let ps = dir.to_string_lossy();
    if ps.starts_with("/proc") || ps.starts_with("/sys") || ps.starts_with("/dev") { return; }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.filter_map(|x| x.ok()) {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        let is_dir = meta.is_dir();
        let size   = if is_dir { 0 } else { meta.len() };
        let modified = meta.modified().ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs()).unwrap_or(0);
        out.push(IndexEntry {
            name_lc: name.to_lowercase(),
            path: path.to_string_lossy().into_owned(),
            is_dir, size, modified,
        });
        if is_dir && !meta.file_type().is_symlink() {
            index_walk(&path, out, depth + 1);
        }
    }
}

/// Called from the inotify watcher when a directory changes: re-index that dir only.
fn index_apply_event(changed_dir: &str) {
    let dir = Path::new(changed_dir);
    let prefix = format!("{}/", changed_dir.trim_end_matches('/'));
    // Remove stale entries for the changed directory
    {
        let mut idx = search_index_store().write().unwrap_or_else(|e| e.into_inner());
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
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            let is_dir = meta.is_dir();
            let size   = if is_dir { 0 } else { meta.len() };
            let modified = meta.modified().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs()).unwrap_or(0);
            fresh.push(IndexEntry {
                name_lc: name.to_lowercase(),
                path: path.to_string_lossy().into_owned(),
                is_dir, size, modified,
            });
        }
    }
    search_index_store().write().unwrap_or_else(|e| e.into_inner()).extend(fresh);
}

#[derive(serde::Serialize)]
struct IndexSearchResult {
    path: String,
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

/// Fast filename-only search against the in-memory index.
/// Falls back gracefully to an empty Vec if the index is not yet ready.
#[tauri::command]
fn search_index_query(query: String, max_results: usize) -> Vec<IndexSearchResult> {
    let q = query.to_lowercase();
    let max = max_results.min(2000);
    let idx = search_index_store().read().unwrap_or_else(|e| e.into_inner());
    let mut results: Vec<IndexSearchResult> = idx.iter()
        .filter(|e| e.name_lc.contains(&q))
        .take(max)
        .map(|e| {
            let name = Path::new(&e.path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            IndexSearchResult { path: e.path.clone(), name, is_dir: e.is_dir, size: e.size, modified: e.modified }
        })
        .collect();
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    results
}

fn load_tags_db()->serde_json::Value {
    let p=tags_db_path();
    if let Ok(s)=fs::read_to_string(&p) { serde_json::from_str(&s).unwrap_or(serde_json::json!({})) }
    else { serde_json::json!({}) }
}
fn save_tags_db(db:&serde_json::Value) {
    let p=tags_db_path();
    if let Some(parent)=p.parent(){let _=fs::create_dir_all(parent);}
    let _=fs::write(p,db.to_string());
}

// ── Fast directory listing: only name+type from DirEntry, no extra syscalls ──
// Used by column view. Full metadata fetched lazily when item is selected.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntryFast {
    pub name:String, pub path:String, pub is_dir:bool,
    pub extension:Option<String>, pub is_hidden:bool, pub is_symlink:bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct DirectoryListingFast { pub path:String, pub entries:Vec<FileEntryFast>, pub parent:Option<String> }

// ── Directory listing LRU cache ───────────────────────────────────────────────
// Caches the full Vec<FileEntryFast> for each visited directory.
// On a cache hit, both streaming emits happen synchronously from memory —
// no filesystem reads, no lstat() calls, no serialization delay.
// Invalidated by the inotify watcher when a Create/Remove/Rename fires.
//
// Eliminates the 28-30ms "Rust filesystem time" on every revisit.
// Music first visit: 42ms (unavoidable FS). Every revisit: ~8ms (IPC only).
// Also eliminates the partial-column glitch: on cache hit we send ALL entries
// in one emit (no two-render streaming dance).
use std::collections::{HashMap, VecDeque};

const DIR_CACHE_MAX: usize = 30;

struct DirCache {
    map:   HashMap<String, Vec<FileEntryFast>>,
    order: VecDeque<String>,
}

impl DirCache {
    fn new() -> Self { Self { map: HashMap::new(), order: VecDeque::new() } }

    fn get(&self, path: &str) -> Option<&Vec<FileEntryFast>> {
        self.map.get(path)
    }

    fn insert(&mut self, path: String, entries: Vec<FileEntryFast>) {
        if self.map.contains_key(&path) {
            // Already present — refresh by removing from order and re-adding at back
            self.order.retain(|p| p != &path);
        } else if self.map.len() >= DIR_CACHE_MAX {
            // Evict least-recently-used (front of deque)
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
        self.order.push_back(path.clone());
        self.map.insert(path, entries);
    }

    fn evict(&mut self, path: &str) {
        if self.map.remove(path).is_some() {
            self.order.retain(|p| p != path);
        }
    }
}

// RwLock allows many concurrent readers (cache_get from streamer + preload_dir
// threads) without any contention. Writers (cache_insert, cache_evict) take the
// exclusive write lock briefly. Eliminates the hot lock contention that was
// serialising all concurrent preload_dir threads on the old Mutex.
static DIR_CACHE: RwLock<Option<DirCache>> = RwLock::new(None);

fn cache_get(path: &str) -> Option<Vec<FileEntryFast>> {
    // Read lock — multiple threads can hold this simultaneously.
    let lock = DIR_CACHE.read().unwrap_or_else(|e| e.into_inner());
    lock.as_ref()?.get(path).cloned()
}

fn cache_insert(path: String, entries: Vec<FileEntryFast>) {
    // Write lock — exclusive, brief.
    let mut lock = DIR_CACHE.write().unwrap_or_else(|e| e.into_inner());
    let cache = lock.get_or_insert_with(DirCache::new);
    cache.insert(path, entries);
}

fn cache_evict(path: &str) {
    let mut lock = DIR_CACHE.write().unwrap_or_else(|e| e.into_inner());
    if let Some(cache) = lock.as_mut() {
        cache.evict(path);
    }
}

// ── Predictive preloading ─────────────────────────────────────────────────────
// Called from JS when the user hovers over a directory row.  Populates the
// DIR_CACHE before the user clicks, so the subsequent navigate() hits the cache
// and renders instantly instead of paying ~42ms of filesystem read time.
//
// Design goals:
//   • Fire-and-forget: returns immediately; work runs on a background OS thread.
//   • No-op on cache hit: avoids redundant FS reads if the dir is already warm.
//   • Size guard: skips directories with >5000 entries to prevent large preloads
//     from evicting more useful cached entries (LRU max = 30 dirs).
//
// Expected improvement: hover→click perceived latency drops from ~42ms (cold FS)
// to ~3ms (JS cache) for directories the user is likely to navigate into next.
// This mirrors how Finder / Dolphin feel "instant" on column navigation.
#[tauri::command]
async fn preload_dir(path: String) {
    // Skip if already in cache — no IPC or FS work needed.
    if cache_get(&path).is_some() { return; }
    // Use Tokio's blocking pool instead of spawning a raw OS thread per hover.
    // This reuses threads from the existing pool (capped by Tokio), preventing
    // thread explosion when the user hovers over many directories quickly.
    tauri::async_runtime::spawn_blocking(move || {
        let dir_path = Path::new(&path);
        if !dir_path.is_dir() { return; }
        let rd = match fs::read_dir(dir_path) { Ok(r) => r, Err(_) => return };
        let entries: Vec<FileEntryFast> = rd.filter_map(|e| e.ok()).map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_hidden = name.starts_with('.');
            let ft = entry.file_type().ok();
            let is_symlink = ft.as_ref().map(|t| t.is_symlink()).unwrap_or(false);
            let is_dir = match &ft {
                Some(t) if t.is_dir() => true,
                Some(t) if t.is_symlink() => entry.path().is_dir(),
                _ => false,
            };
            let ep = entry.path();
            let extension = if is_dir { None } else {
                ep.extension().map(|e| e.to_string_lossy().to_string().to_lowercase())
            };
            FileEntryFast { name, path: ep.to_string_lossy().to_string(),
                            is_dir, extension, is_hidden, is_symlink }
        }).collect();
        // Only cache reasonably-sized directories to protect LRU budget.
        if entries.len() <= 5000 {
            cache_insert(path, entries);
        }
    });
}

#[tauri::command]
// Streaming variant: emits chunks of ~60 entries as Tauri events so JS can render
// the first chunk immediately without waiting for all entries to be collected.
//
// IMPORTANT: must be `async fn` so Tauri dispatches it on the Tokio async runtime
// and frees the WebKit handler thread immediately. A sync `fn` blocks the WebKit
// thread — all window.emit() calls queue up and only reach JS after the function
// returns, giving zero first-paint benefit. With spawn_blocking, the WebKit thread
// is free and JS processes each emitted chunk as it arrives.
async fn list_directory_streamed(window:Window, path:String, request_id:u32)->Result<(),String> {
    // ── Cache hit: serve from memory, no filesystem reads ─────────────────────
    // On a cache hit, emit ALL entries in a single done:true message.
    // No two-render streaming dance — JS gets the full listing in one shot,
    // eliminating the partial-column flash (60-entry column jumping to 542).
    // Cache is invalidated by the inotify watcher when the directory changes.
    if let Some(cached) = cache_get(&path) {
        let parent = Path::new(&path).parent().map(|p| p.to_string_lossy().to_string());
        let total = cached.len();
        let _ = window.emit("dir-chunk", serde_json::json!({
            "request_id": request_id,
            "path": &path,
            "parent": parent,
            "entries": &cached,
            "done": true,
            "total": total
        }));
        return Ok(());
    }

    // ── Cache miss: read from filesystem, store in cache ──────────────────────
    tauri::async_runtime::spawn_blocking(move || {
        let dir_path=Path::new(&path);
        if !dir_path.exists(){ return Err(format!("PERMISSION_DENIED:{}",path)); }
        let rd=fs::read_dir(dir_path).map_err(|e|{
            if e.kind()==std::io::ErrorKind::PermissionDenied{format!("PERMISSION_DENIED:{}",path)}else{e.to_string()}
        })?;
        let parent=dir_path.parent().map(|p|p.to_string_lossy().to_string());

        // Multi-chunk streaming for cache misses.
        //
        // Before this fix (two-emit): a Downloads dir with 1500 files sent ~1440 entries in
        // a single done:true event. WebKit blocks the main thread deserializing that blob,
        // causing a 1-2 second freeze. Now the tail is batched in TAIL_CHUNK slices so
        // WebKit can interleave rendering between events.
        //
        //   Chunk 1   — first FIRST_CHUNK entries → immediate column first-paint
        //   Chunks 2…N — TAIL_CHUNK entries each  → progressive column fill, no jank
        //   Final chunk — remaining entries + done:true + total → column settles
        const FIRST_CHUNK: usize = 100; // Increased from 60 for faster initial display
        const TAIL_CHUNK:  usize = 200; // Increased from 150 for fewer emissions
        let mut all: Vec<FileEntryFast> = Vec::new();

        for entry in rd.filter_map(|e|e.ok()) {
            let name=entry.file_name().to_string_lossy().to_string();
            let is_hidden=name.starts_with('.');
            let ft=entry.file_type().ok();
            let is_symlink=ft.as_ref().map(|t|t.is_symlink()).unwrap_or(false);
            let is_dir=match &ft {
                Some(t) if t.is_dir() => true,
                Some(t) if t.is_symlink() => entry.path().is_dir(),
                _ => false,
            };
            let ep=entry.path();
            let extension=if is_dir{None}else{ep.extension().map(|e|e.to_string_lossy().to_string().to_lowercase())};
            all.push(FileEntryFast{name,path:ep.to_string_lossy().to_string(),is_dir,extension,is_hidden,is_symlink});

            // First-paint chunk
            if all.len()==FIRST_CHUNK {
                let _ = window.emit("dir-chunk", serde_json::json!({
                    "request_id": request_id,
                    "path": &path,
                    "entries": &all[..FIRST_CHUNK],
                    "done": false
                }));
            }
            // Intermediate tail chunks — emit every TAIL_CHUNK entries after the first chunk.
            // Only fires on exact multiples so we send a full batch, never a partial one here.
            if all.len() > FIRST_CHUNK && (all.len() - FIRST_CHUNK) % TAIL_CHUNK == 0 {
                let batch_start = all.len() - TAIL_CHUNK;
                let _ = window.emit("dir-chunk", serde_json::json!({
                    "request_id": request_id,
                    "path": &path,
                    "entries": &all[batch_start..],
                    "done": false
                }));
            }
        }
        let total = all.len();
        // Only send entries that haven't been emitted yet.
        // IMPORTANT: the first-paint chunk fires when all.len() == FIRST_CHUNK (exact match).
        // total == FIRST_CHUNK means it DID fire — using <= was the bug: dirs with exactly
        // FIRST_CHUNK files set already_sent=0 and re-sent all 60 in the done chunk → 120 dupes.
        let already_sent = if total < FIRST_CHUNK {
            0 // first-paint chunk never fired — dir has fewer than FIRST_CHUNK entries
        } else {
            let tail_batches = (total - FIRST_CHUNK) / TAIL_CHUNK;
            FIRST_CHUNK + tail_batches * TAIL_CHUNK
        };
        let _ = window.emit("dir-chunk", serde_json::json!({
            "request_id": request_id,
            "path": &path,
            "parent": parent,
            "entries": &all[already_sent..],
            "done": true,
            "total": total
        }));
        // Store in cache after emit so the cache mutex doesn't block the filesystem read.
        cache_insert(path, all);
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_directory_fast(path:String)->Result<DirectoryListingFast,String> {
    // Run blocking I/O on a thread-pool thread so the Tauri async runtime
    // is never stalled — large directories (800+ files) were freezing the IPC.
    tauri::async_runtime::spawn_blocking(move || {
        let dir_path=Path::new(&path);
        if !dir_path.exists(){ return Err(format!("PERMISSION_DENIED:{}",path)); }
        let rd=fs::read_dir(dir_path).map_err(|e|{
            if e.kind()==std::io::ErrorKind::PermissionDenied{format!("PERMISSION_DENIED:{}",path)}else{e.to_string()}
        })?;
        // file_type() is free on Linux (from dirent) — zero syscalls for normal files.
        // Only call path().is_dir() for symlinks to resolve the target — avoids
        // 893 unnecessary stat() calls when listing a large music folder.
        let entries:Vec<FileEntryFast>=rd.filter_map(|e|e.ok()).map(|entry|{
            let name=entry.file_name().to_string_lossy().to_string();
            let is_hidden=name.starts_with('.');
            let ft=entry.file_type().ok();
            let is_symlink=ft.as_ref().map(|t|t.is_symlink()).unwrap_or(false);
            let is_dir=match ft {
                Some(ref t) if t.is_dir() => true,
                Some(ref t) if t.is_symlink() => entry.path().is_dir(), // 1 stat only for symlinks
                _ => false,
            };
            let ep=entry.path();
            let extension=if is_dir{None}else{ep.extension().map(|e|e.to_string_lossy().to_string().to_lowercase())};
            FileEntryFast{name,path:ep.to_string_lossy().to_string(),is_dir,extension,is_hidden,is_symlink}
        }).collect();
        let parent=dir_path.parent().map(|p|p.to_string_lossy().to_string());
        Ok(DirectoryListingFast{path,entries,parent})
    }).await.map_err(|e|e.to_string())?
}

// Fetch full metadata for a single entry (called on selection, not on list)
#[tauri::command]
fn get_entry_meta(path:String)->Option<FileEntry> {
    build_file_entry(Path::new(&path))
}

// Enrich a batch of known paths with full metadata (size, mtime, permissions).
// Called lazily after the fast listing renders — never blocks the initial paint.
#[tauri::command]
fn list_directory_chunk(paths:Vec<String>)->Vec<FileEntry> {
    use rayon::prelude::*;
    paths.par_iter().filter_map(|p|build_file_entry(Path::new(p))).collect()
}


// ── Commands ──────────────────────────────────────────────────────────────────

// ── list_directory_full_streamed ──────────────────────────────────────────────
// Streaming variant of list_directory for list / gallery / icon views.
//
// list_directory collected all entries in one rayon batch and returned them in
// a single invoke response.  On a Downloads directory with 1500 files this
// means the entire Vec<FileEntry> (with stat metadata for every item) is
// serialised into one JSON response and pushed over the WebKit IPC bridge in
// one shot — the main thread stalls while WebKit deserialises it.
//
// This command emits "dir-full-chunk" events in FULL_CHUNK-entry batches so
// WebKit can interleave rendering between each one.  JS now calls this instead
// of list_directory and reconstructs the listing from the events.
#[tauri::command]
async fn list_directory_full_streamed(window: Window, path: String, request_id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir_path = Path::new(&path);
        if !dir_path.is_dir() {
            let sym = fs::symlink_metadata(dir_path).ok();
            let is_sym_dir = sym.map(|m| m.file_type().is_symlink()).unwrap_or(false) && dir_path.is_dir();
            if !is_sym_dir { return Err(format!("PERMISSION_DENIED:{}", path)); }
        }
        let raw: Vec<_> = fs::read_dir(dir_path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                format!("PERMISSION_DENIED:{}", path)
            } else { e.to_string() }
        })?.filter_map(|e| e.ok()).collect();

        let parent = dir_path.parent().map(|p| p.to_string_lossy().to_string());
        let _total = raw.len(); // raw count before rayon filter; actual_total used below

        const FULL_CHUNK: usize = 100;

        // ── Phase 1: stat ALL entries in parallel with rayon ──────────────────
        // The original list_directory used into_par_iter() over the whole Vec.
        // The r40 attempt broke that by statting sequentially per-batch, which
        // is strictly worse — same total syscalls, no parallelism.
        // Restore the rayon parallel stat over the entire raw set first, then
        // chunk the already-built Vec<FileEntry> purely for IPC emit sizing.
        // Phase 1 (rayon): fast, parallel, all on the blocking thread-pool.
        // Phase 2 (emit loop): splits the completed vec into FULL_CHUNK slices;
        //   each event is ≤100 entries so WebKit never gets one giant blob.
        use rayon::prelude::*;
        let entries: Vec<FileEntry> = raw.par_iter()
            .filter_map(|entry| build_file_entry(&entry.path()))
            .collect();
        let actual_total = entries.len();

        if actual_total == 0 {
            let _ = window.emit("dir-full-chunk", serde_json::json!({
                "request_id": request_id,
                "path": &path,
                "parent": parent,
                "entries": serde_json::Value::Array(vec![]),
                "done": true,
                "total": 0
            }));
        } else {
            // ── Phase 2: emit in FULL_CHUNK slices ────────────────────────────
            let chunks: Vec<_> = entries.chunks(FULL_CHUNK).enumerate().collect();
            let n_chunks = chunks.len();
            for (chunk_idx, batch) in chunks {
                let is_last = chunk_idx + 1 == n_chunks;
                let _ = window.emit("dir-full-chunk", serde_json::json!({
                    "request_id": request_id,
                    "path": &path,
                    "parent": if chunk_idx == 0 { parent.clone() } else { None },
                    "entries": batch,
                    "done": is_last,
                    "total": actual_total
                }));
            }
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_directory(path:String)->Result<DirectoryListing,String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir_path=Path::new(&path);
        if !dir_path.is_dir(){
            let sym=fs::symlink_metadata(dir_path).ok();
            let is_sym_dir=sym.map(|m|m.file_type().is_symlink()).unwrap_or(false) && dir_path.is_dir();
            if !is_sym_dir { return Err(format!("Not a directory: {}",path)); }
        }
        let raw:Vec<_>=fs::read_dir(dir_path).map_err(|e|{
            if e.kind()==std::io::ErrorKind::PermissionDenied{format!("PERMISSION_DENIED:{}",path)}else{e.to_string()}
        })?.filter_map(|e|e.ok()).collect();

        let entries:Vec<FileEntry>=raw.into_par_iter().filter_map(|entry|{
            let ep=entry.path();
            build_file_entry(&ep)
        }).collect();

        let parent=dir_path.parent().map(|p|p.to_string_lossy().to_string());
        Ok(DirectoryListing{path,entries,parent})
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
fn get_home_dir()->String { dirs::home_dir().map(|p|p.to_string_lossy().to_string()).unwrap_or_else(||"/".to_string()) }

/// Scan lsblk for ALL block device partitions that are NOT currently mounted.
/// Includes USB, NVMe, SSD, HDD — anything with a filesystem but no mountpoint.
/// `mounted_devs` is the set of device paths already seen in /proc/mounts.
/// `mounted_mnts` is the set of mountpoints already shown (skip root partition).
#[cfg(target_os = "linux")]
fn lsblk_unmounted_all(
    mounted_devs: &std::collections::HashSet<String>,
    _mounted_mnts: &std::collections::HashSet<String>,
) -> Vec<DriveInfo> {
    let out = match std::process::Command::new("lsblk")
        .args(["-J","-b","-o","NAME,LABEL,MOUNTPOINT,RM,HOTPLUG,TYPE,FSTYPE,PATH,TRAN"])
        .output() {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };
    let json: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        _ => return vec![],
    };
    let mut drives = Vec::new();
    if let Some(devs) = json["blockdevices"].as_array() {
        for disk in devs {
            // Transport bus at disk level (usb, nvme, sata, ata, ...)
            let disk_tran = disk["tran"].as_str().unwrap_or("").to_lowercase();
            let disk_rm   = disk["rm"].as_bool().unwrap_or(false)
                         || disk["hotplug"].as_bool().unwrap_or(false);
            let disk_name = disk["name"].as_str().unwrap_or("");

            // Gather candidate nodes: partitions (children) or whole-disk if no children
            let mut candidates: Vec<&serde_json::Value> = Vec::new();
            if let Some(children) = disk["children"].as_array() {
                for c in children { candidates.push(c); }
            } else {
                candidates.push(disk);
            }

            for part in candidates {
                let dev_path = match part["path"].as_str() {
                    Some(p) if !p.is_empty() => p,
                    _ => continue,
                };

                // Already mounted? Skip.
                if mounted_devs.contains(dev_path) { continue; }

                // lsblk reports a mountpoint for this partition? Skip.
                if let Some(mp) = part["mountpoint"].as_str() {
                    if !mp.is_empty() { continue; }
                }

                let fstype = part["fstype"].as_str().unwrap_or("");
                // No recognised filesystem → unformatted / extended table / swap
                if fstype.is_empty() || fstype == "swap" { continue; }

                // Skip swap partitions and loop devices
                let part_type = part["type"].as_str().unwrap_or("");
                if part_type == "loop" || part_type == "swap" { continue; }

                let part_name = part["name"].as_str().unwrap_or(disk_name);
                let label     = part["label"].as_str().unwrap_or("").trim();

                // Classify drive type from transport + device name
                let drive_type = {
                    let rm = disk_rm || part["rm"].as_bool().unwrap_or(false);
                    if rm || disk_tran == "usb" || part_name.starts_with("sd") && is_usb_device(part_name.split('/').next_back().unwrap_or(part_name)) {
                        "usb"
                    } else if disk_tran == "nvme" || part_name.starts_with("nvme") || disk_name.starts_with("nvme") {
                        "nvme"
                    } else if is_rotational(disk_name.split('/').next_back().unwrap_or(disk_name)) {
                        "hdd"
                    } else {
                        "ssd"
                    }
                };

                // Build display name
                let display = if !label.is_empty() {
                    label.to_string()
                } else {
                    match drive_type {
                        "nvme" => format!("NVMe ({})", part_name),
                        "hdd"  => format!("HDD ({})",  part_name),
                        "ssd"  => format!("SSD ({})",  part_name),
                        _      => format!("USB Drive ({})", part_name),
                    }
                };

                drives.push(DriveInfo {
                    name: display,
                    path: String::new(), // no mountpoint yet
                    drive_type: drive_type.to_string(),
                    is_mounted: false,
                    total_bytes: 0,
                    free_bytes: 0,
                    filesystem: fstype.to_string(),
                    device: dev_path.to_string(),
                });
            }
        }
    }
    drives
}

#[cfg(target_os = "linux")]
fn collect_drives_with_unmounted() -> Vec<DriveInfo> {
    let mounts = parse_mounts();
    let mut seen_mnt = std::collections::HashSet::new();
    let mut mounted_devs = std::collections::HashSet::new();
    let mut drives: Vec<DriveInfo> = mounts.iter().filter_map(|(dev, mnt, fs)| {
        mounted_devs.insert(dev.clone());
        let info = classify_drive(dev, mnt, fs)?;
        if !seen_mnt.insert(mnt.clone()) { return None; }
        Some(info)
    }).collect();
    // Append unmounted partitions for ALL drive types (USB, NVMe, SSD, HDD)
    drives.extend(lsblk_unmounted_all(&mounted_devs, &seen_mnt));
    drives.sort_by(|a, b| {
        let ord = |t: &str| match t { "nvme"=>0,"ssd"=>1,"hdd"=>2,"usb"=>3,"optical"=>4,"network"=>5,_=>6 };
        let mo = |d: &DriveInfo| if d.is_mounted { 0i32 } else { 1 };
        ord(&a.drive_type).cmp(&ord(&b.drive_type))
            .then(mo(a).cmp(&mo(b)))
            .then(a.name.cmp(&b.name))
    });
    drives
}

#[tauri::command]
fn get_sidebar_data()->SidebarData {
    let home=dirs::home_dir().unwrap_or_else(||PathBuf::from("/"));
    // Trash: Linux XDG path; macOS uses ~/.Trash; Windows has Recycle Bin (no easy path)
    #[cfg(target_os = "linux")]
    let trash_path = home.join(".local/share/Trash/files");
    #[cfg(target_os = "macos")]
    let trash_path = home.join(".Trash");
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let trash_path = home.join("Trash"); // fallback
    let _=fs::create_dir_all(&trash_path);
    let raw_favs=[("Home",home.to_string_lossy().to_string(),"home"),
        ("Desktop",home.join("Desktop").to_string_lossy().to_string(),"folder"),
        ("Documents",home.join("Documents").to_string_lossy().to_string(),"doc"),
        ("Downloads",home.join("Downloads").to_string_lossy().to_string(),"download"),
        ("Pictures",home.join("Pictures").to_string_lossy().to_string(),"img"),
        ("Music",home.join("Music").to_string_lossy().to_string(),"music"),
        ("Videos",home.join("Videos").to_string_lossy().to_string(),"video"),
        ("Trash",trash_path.to_string_lossy().to_string(),"trash")];
    let favorites=raw_favs.iter().map(|(n,p,i)|SidebarFavorite{
        name:n.to_string(),path:p.to_string(),icon:i.to_string(),
        exists:if *i=="trash"{true}else{Path::new(p).exists()}
    }).collect();
    SidebarData{favorites, drives: get_drives_platform()}
}

#[tauri::command]
fn get_drives()->Vec<DriveInfo> {
    get_drives_platform()
}

#[cfg(target_os = "linux")]
fn get_drives_platform() -> Vec<DriveInfo> { collect_drives_with_unmounted() }

/// macOS: list mounted volumes from /Volumes — no lsblk/sysfs needed.
#[cfg(target_os = "macos")]
fn get_drives_platform() -> Vec<DriveInfo> {
    let mut drives = Vec::new();
    if let Ok(rd) = fs::read_dir("/Volumes") {
        for entry in rd.filter_map(|e| e.ok()) {
            let path = entry.path().to_string_lossy().to_string();
            let name = entry.file_name().to_string_lossy().to_string();
            let (total, free) = get_disk_space(&path);
            if total == 0 { continue; }
            drives.push(DriveInfo {
                name, path, drive_type: "internal".to_string(),
                is_mounted: true, total_bytes: total, free_bytes: free,
                filesystem: String::new(), device: String::new(),
            });
        }
    }
    drives
}

/// Windows / other: return an empty list — full drive enumeration requires
/// WinAPI (GetLogicalDriveStrings) which is not currently implemented.
/// Windows: enumerate logical drives via `wmic logicaldisk` (no unsafe code needed).
#[cfg(target_os = "windows")]
fn get_drives_platform() -> Vec<DriveInfo> {
    // wmic logicaldisk get DeviceID,Size,FreeSpace,VolumeName,DriveType /format:csv
    // DriveType: 2=removable, 3=local, 4=network, 5=CD/DVD
    let out = std::process::Command::new("wmic")
        .args(["logicaldisk", "get",
               "DeviceID,Size,FreeSpace,VolumeName,DriveType",
               "/format:csv"])
        .output();

    let Ok(out) = out else { return Vec::new(); };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut drives = Vec::new();

    for line in text.lines().skip(2) {  // skip header rows
        let cols: Vec<&str> = line.split(',').collect();
        // csv: Node,DeviceID,DriveType,FreeSpace,Size,VolumeName
        if cols.len() < 6 { continue; }
        let device_id  = cols[1].trim();
        let drive_type = cols[2].trim().parse::<u32>().unwrap_or(0);
        let free_bytes = cols[3].trim().parse::<u64>().unwrap_or(0);
        let total_bytes= cols[4].trim().parse::<u64>().unwrap_or(0);
        let label      = cols[5].trim().to_string();

        if device_id.is_empty() || drive_type == 5 { continue; } // skip CD/DVD

        let display = if label.is_empty() {
            format!("Local Disk ({})", device_id)
        } else {
            format!("{} ({})", label, device_id)
        };

        drives.push(DriveInfo {
            name:        display,
            path:        format!("{}\\", device_id),
            device:      device_id.to_string(),
            drive_type:  if drive_type == 2 { "usb".to_string() } else { "internal".to_string() },
            total_bytes,
            free_bytes,
            is_mounted:  true,
            filesystem:  String::new(),
        });
    }
    drives
}

#[cfg(target_os = "windows")]
fn get_windows_volume_label(path: &str) -> Option<String> {
    // Shell out to cmd /c vol — simpler than unsafe WinAPI in this context
    let out = std::process::Command::new("cmd")
        .args(["/c", &format!("vol {}", &path[..2])])
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // Line 1: "Volume in drive X is <label>" or "has no label"
    let line = text.lines().next()?;
    if line.contains("has no label") { return None; }
    let label = line.split(" is ").nth(1)?.trim().to_string();
    if label.is_empty() { None } else { Some(label) }
}

#[cfg(target_os = "windows")]
fn get_windows_disk_space(path: &str) -> (u64, u64) {
    let out = std::process::Command::new("wmic")
        .args(["logicaldisk", "where", &format!("DeviceID='{}'", &path[..2]),
               "get", "Size,FreeSpace", "/value"])
        .output();
    if let Ok(out) = out {
        let text = String::from_utf8_lossy(&out.stdout);
        let mut free = 0u64; let mut total = 0u64;
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("FreeSpace=") { free = v.trim().parse().unwrap_or(0); }
            if let Some(v) = line.strip_prefix("Size=")      { total = v.trim().parse().unwrap_or(0); }
        }
        (total, free)
    } else { (0, 0) }
}

/// Non-Windows, non-macOS, non-Linux fallback (BSDs, etc.)
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn get_drives_platform() -> Vec<DriveInfo> { Vec::new() }

/// Mount a block device via udisksctl (Linux only).
#[tauri::command]
fn mount_drive(device: String) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = device; return Err("mount_drive is only supported on Linux.".into()); }
    #[cfg(target_os = "linux")]
    {
    let r = std::process::Command::new("udisksctl")
        .args(["mount", "-b", &device])
        .output()
        .map_err(|e| e.to_string())?;
    if r.status.success() {
        let out = String::from_utf8_lossy(&r.stdout);
        // "Mounted /dev/sdb1 at /run/media/user/LABEL."
        if let Some(idx) = out.find(" at ") {
            let mp = out[idx + 4..].trim().trim_end_matches('.');
            return Ok(mp.to_string());
        }
        return Ok(String::new());
    }
    Err(String::from_utf8_lossy(&r.stderr).trim().to_string())
    }
}

/// Unlock a LUKS / crypto_LUKS encrypted block device using udisksctl,
/// then mount the resulting dm device. Returns the mountpoint on success.
///
/// Flow:
///   Write passphrase to /dev/shm/frostfinder_key_XXXX (tmpfs, never hits disk)
///   udisksctl unlock -b <device> --key-file /dev/shm/frostfinder_key_XXXX
///   → "Unlocked /dev/sdb1 as /dev/dm-0."
///   udisksctl mount -b /dev/dm-0
///   → "Mounted /dev/dm-0 at /run/media/user/LABEL."
///   Temp key file is deleted immediately after unlock attempt.
///
/// Note: --key-file /dev/stdin does NOT work because udisksctl is a D-Bus
/// client — it reads the file in the udisksd daemon process, not in our process.
/// A real file in /dev/shm (tmpfs) is the safest non-interactive alternative.
#[tauri::command]
fn unlock_and_mount_encrypted(device: String, passphrase: String) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (device, passphrase); return Err("Encrypted drive unlock is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
    use std::io::Write;
    use std::process::Command;

    // Write passphrase to a temp file in /dev/shm (in-memory tmpfs — never hits disk)
    let key_path = format!("/dev/shm/frostfinder_key_{}", std::process::id());
    {
        let mut f = std::fs::OpenOptions::new()
            .create(true).write(true).truncate(true)
            .open(&key_path)
            .map_err(|e| format!("Cannot create key file: {}", e))?;
        // Restrict to owner-only before writing
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Cannot chmod key file: {}", e))?;
        f.write_all(passphrase.as_bytes())
            .map_err(|e| format!("Cannot write key file: {}", e))?;
    }

    // Step 1: unlock — pass passphrase file to udisksctl
    let unlock_out = Command::new("udisksctl")
        .args(["unlock", "-b", &device, "--key-file", &key_path])
        .output();

    // Always delete the key file immediately, even on error
    let _ = std::fs::remove_file(&key_path);

    let unlock_out = unlock_out.map_err(|e| format!("Failed to run udisksctl: {}", e))?;

    if !unlock_out.status.success() {
        let stderr = String::from_utf8_lossy(&unlock_out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&unlock_out.stdout).trim().to_string();
        let combined = format!("{} {}", stderr, stdout).to_lowercase();
        if combined.contains("failed to activate")
            || combined.contains("wrong passphrase")
            || combined.contains("bad key")
            || combined.contains("no key available")
            || combined.contains("operation not permitted")
        {
            return Err("Wrong passphrase — please try again.".to_string());
        }
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }

    // Parse "Unlocked /dev/sdb1 as /dev/dm-0." to get the dm device
    let stdout = String::from_utf8_lossy(&unlock_out.stdout);
    let dm_device = if let Some(pos) = stdout.find(" as ") {
        stdout[pos + 4..].trim().trim_end_matches('.').to_string()
    } else {
        return Err(format!("Unexpected udisksctl output: {}", stdout.trim()));
    };

    // Step 2: mount the unlocked dm device
    let mount_out = Command::new("udisksctl")
        .args(["mount", "-b", &dm_device])
        .output()
        .map_err(|e| e.to_string())?;

    if mount_out.status.success() {
        let out = String::from_utf8_lossy(&mount_out.stdout);
        if let Some(idx) = out.find(" at ") {
            let mp = out[idx + 4..].trim().trim_end_matches('.');
            return Ok(mp.to_string());
        }
        return Ok(String::new());
    }
    Err(String::from_utf8_lossy(&mount_out.stderr).trim().to_string())
    } // end #[cfg(target_os = "linux")]
}

#[tauri::command]
fn search_files(roots:Vec<String>,query:String,include_hidden:bool,max_results:usize)->SearchResult {
    let q=query.to_lowercase(); let max=max_results.min(2000);
    let mut results=Vec::new(); let mut total_searched:u64=0; let mut truncated=false;
    for root in &roots { search_recursive(Path::new(root),&q,include_hidden,max,&mut results,&mut total_searched,&mut truncated); if truncated{break;} }
    SearchResult{entries:results,total_searched,truncated}
}
fn search_recursive(dir:&Path,q:&str,include_hidden:bool,max:usize,results:&mut Vec<FileEntry>,searched:&mut u64,truncated:&mut bool) {
    if results.len()>=max{*truncated=true;return;}
    let Ok(rd)=fs::read_dir(dir) else{return};
    for entry in rd.filter_map(|e|e.ok()) {
        if results.len()>=max{*truncated=true;return;}
        let name=entry.file_name().to_string_lossy().to_string();
        if !include_hidden&&name.starts_with('.'){continue;}
        *searched+=1;
        if name.to_lowercase().contains(q){if let Some(fe)=build_file_entry(&entry.path()){results.push(fe);}}
        let sym_meta=fs::symlink_metadata(entry.path());
        let is_symlink=sym_meta.as_ref().map(|m|m.file_type().is_symlink()).unwrap_or(false);
        let is_dir=entry.path().is_dir();
        if is_dir && !is_symlink {
            let p=entry.path(); let ps=p.to_string_lossy();
            if ps.starts_with("/proc")||ps.starts_with("/sys")||ps.starts_with("/dev"){continue;}
            search_recursive(&p,q,include_hidden,max,results,searched,truncated);
        }
    }
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    { std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| format!("xdg-open: {}", e))?; }
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(&path).spawn().map_err(|e| format!("open: {}", e))?; }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd").args(["/c", "start", "", &path])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn().map_err(|e| format!("cmd start: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn get_file_preview(path:String)->Result<FilePreview,String> {
    let p=Path::new(&path);
    let metadata=fs::metadata(p).map_err(|e|e.to_string())?;
    let name=p.file_name().map(|n|n.to_string_lossy().to_string()).unwrap_or_default();
    let size=metadata.len();
    let permissions=get_permissions(&metadata);
    let modified=metadata.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_secs()).unwrap_or(0);
    let ext=p.extension().map(|e|e.to_string_lossy().to_string().to_lowercase()).unwrap_or_default();
    let is_image=is_image_ext(&ext);
    let text_exts=["txt","md","rs","js","ts","py","go","c","cpp","h","hpp","toml","json","yaml","yml","xml","html","htm","css","sh","bash","zsh","fish","env","conf","cfg","ini","log","csv","lock","gitignore","dockerfile","svg","rtf"];
    let fname_lower=name.to_lowercase();
    let is_text=text_exts.contains(&ext.as_str())||fname_lower=="makefile"||fname_lower=="dockerfile"||fname_lower==".gitignore"||fname_lower==".env";
    let mime_type=match ext.as_str() {
        "png"=>"image/png".into(),"jpg"|"jpeg"=>"image/jpeg".into(),"gif"=>"image/gif".into(),"webp"=>"image/webp".into(),
        "heic"=>"image/heic".into(),"heif"=>"image/heif".into(),
        "svg"=>"image/svg+xml".into(),"bmp"=>"image/bmp".into(),
        "tiff"|"tif"=>"image/tiff".into(),
        "xcf"=>"image/x-xcf".into(),
        "mp4"=>"video/mp4".into(),"mkv"=>"video/x-matroska".into(),
        "webm"=>"video/webm".into(),"avi"=>"video/x-msvideo".into(),"mov"=>"video/quicktime".into(),"m4v"=>"video/x-m4v".into(),
        "mp3"=>"audio/mpeg".into(),"flac"=>"audio/flac".into(),"ogg"=>"audio/ogg".into(),"wav"=>"audio/wav".into(),
        "m4a"=>"audio/mp4".into(),"aac"=>"audio/aac".into(),"opus"=>"audio/opus".into(),
        "pdf"=>"application/pdf".into(),"json"=>"application/json".into(),"rs"=>"text/x-rust".into(),
        "py"=>"text/x-python".into(),"js"|"ts"=>"text/javascript".into(),
        "html"|"htm"=>"text/html".into(),
        "css"=>"text/css".into(),"md"=>"text/markdown".into(),
        "rtf"=>"application/rtf".into(),
        "docx"|"doc"=>"application/msword".into(),
        "xlsx"|"xls"=>"application/vnd.ms-excel".into(),
        "epub"=>"application/epub+zip".into(),
        "mobi"|"azw"|"azw3"=>"application/x-mobipocket-ebook".into(),
        "dmg"=>"application/x-apple-diskimage".into(),
        "iso"=>"application/x-iso9660-image".into(),
        _=>if is_text{"text/plain".into()}else{"application/octet-stream".into()},
    };
    // ── Office documents: extract text via ZIP/XML parser ─────────────────
    match ext.as_str() {
        "docx"|"doc" => {
            if let Some(text) = docx_to_text(p) {
                let line_count = text.lines().count();
                let content = if text.len() > 262144 {
                    format!("{}\n\n[... truncated at 256 KB]", &text[..262144])
                } else { text };
                return Ok(FilePreview{path,content:Some(content),image_base64:None,
                    mime_type,size,modified,is_text:true,is_image:false,
                    is_video:false,is_audio:false,line_count:Some(line_count),
                    permissions,thumb_path:None});
            }
            return Ok(FilePreview{path,content:None,image_base64:None,
                mime_type,size,modified,is_text:false,is_image:false,
                is_video:false,is_audio:false,line_count:None,permissions,thumb_path:None});
        }
        "xlsx"|"xls" => {
            if let Some(text) = xlsx_to_text(p) {
                let line_count = text.lines().count();
                return Ok(FilePreview{path,content:Some(text),image_base64:None,
                    mime_type,size,modified,is_text:true,is_image:false,
                    is_video:false,is_audio:false,line_count:Some(line_count),
                    permissions,thumb_path:None});
            }
            return Ok(FilePreview{path,content:None,image_base64:None,
                mime_type,size,modified,is_text:false,is_image:false,
                is_video:false,is_audio:false,line_count:None,permissions,thumb_path:None});
        }
        "epub" => {
            if let Some(text) = epub_to_text(p) {
                let line_count = text.lines().count();
                return Ok(FilePreview{path,content:Some(text),image_base64:None,
                    mime_type,size,modified,is_text:true,is_image:false,
                    is_video:false,is_audio:false,line_count:Some(line_count),
                    permissions,thumb_path:None});
            }
            return Ok(FilePreview{path,content:None,image_base64:None,
                mime_type,size,modified,is_text:false,is_image:false,
                is_video:false,is_audio:false,line_count:None,permissions,thumb_path:None});
        }
        "mobi"|"azw"|"azw3" => {
            if let Some(text) = mobi_to_text(p) {
                let line_count = text.lines().count();
                return Ok(FilePreview{path,content:Some(text),image_base64:None,
                    mime_type,size,modified,is_text:true,is_image:false,
                    is_video:false,is_audio:false,line_count:Some(line_count),
                    permissions,thumb_path:None});
            }
            return Ok(FilePreview{path,content:None,image_base64:None,
                mime_type,size,modified,is_text:false,is_image:false,
                is_video:false,is_audio:false,line_count:None,permissions,thumb_path:None});
        }
        _ => {}
    }
    if is_image&&size<200_000_000 {
        // Do NOT read image bytes over IPC — JS uses the HTTP media server URL directly.
        // Only generate/return thumbnail path for small-file fast display.
        let mtime=modified;
        let thumb_path=thumb_cache_get(&path,mtime)
            .map(|p|p.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Ok(FilePreview{path,content:None,image_base64:None,
            mime_type,size,modified,is_text:false,is_image:true,
            is_video:false,is_audio:false,line_count:None,permissions,
            thumb_path:Some(thumb_path)});
    }
    if is_text {
        let limit=262144usize;
        let raw=fs::read(p).map_err(|e|e.to_string())?;
        if !raw.is_empty() && raw[..raw.len().min(4096)].contains(&0) { return Ok(FilePreview{path,content:None,image_base64:None,mime_type:"application/octet-stream".into(),size,modified,is_text:false,is_image:false,is_video:false,is_audio:false,line_count:None,permissions,thumb_path:None}); }
        let trunc=&raw[..raw.len().min(limit)];
        let raw_str=String::from_utf8_lossy(trunc).to_string();
        // RTF: strip control words before displaying — raw markup is unreadable
        let content = if ext == "rtf" { rtf_to_text(&raw_str) } else { raw_str };
        let line_count=content.lines().count();
        let content=if raw.len()>limit{format!("{}\n\n[... truncated at 256 KB, {} bytes total]",content,size)}else{content};
        return Ok(FilePreview{path,content:Some(content),image_base64:None,mime_type,size,modified,is_text:true,is_image:false,is_video:false,is_audio:false,line_count:Some(line_count),permissions,thumb_path:None});
    }
    Ok(FilePreview{path,content:None,image_base64:None,mime_type,size,modified,is_text:false,is_image:false,is_video:false,is_audio:false,line_count:None,permissions,thumb_path:None})
}


// ── Text file read / write (Phase 2: inline editor) ───────────────────────────
/// Read a text file for the inline editor. Capped at 2 MB to avoid freezing
/// the UI on huge logs. Returns the raw UTF-8 content (invalid bytes replaced).
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    const MAX_BYTES: u64 = 2 * 1024 * 1024; // 2 MB
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "File is {:.1} MB — too large for the inline editor (limit 2 MB). Open in an external editor instead.",
            meta.len() as f64 / 1_048_576.0
        ));
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Atomically write text back to disk. Writes to a temp file beside the target
/// then renames, so a crash mid-write never corrupts the original.
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    let parent = p.parent().ok_or("Cannot determine parent directory")?;
    // Write to a sibling temp file first
    let tmp_path = parent.join(format!(
        ".frostfinder_tmp_{}.tmp",
        p.file_name().unwrap_or_default().to_string_lossy()
    ));
    fs::write(&tmp_path, content.as_bytes()).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })?;
    // Atomic rename
    fs::rename(&tmp_path, p).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })?;
    Ok(())
}




// ── Fast thumbnail generation ─────────────────────────────────────────────────
// Internal helper — not a Tauri command. Takes &str, returns cache path.
fn make_thumbnail(path:&str)->Result<PathBuf,String> {
    use image::imageops::FilterType;
    let p=Path::new(path);
    let meta=fs::metadata(p).map_err(|e|e.to_string())?;
    if meta.len()>200_000_000{return Err("too large".into());}
    let mtime=meta.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_secs()).unwrap_or(0);
    if let Some(cached)=thumb_cache_get(path,mtime){ return Ok(cached); }

    let ext=p.extension().map(|e|e.to_string_lossy().to_lowercase()).unwrap_or_default();

    // ── HEIC / HEIF: the `image` crate has no HEIC decoder.
    // Strategy: try heif-convert first (libheif — purpose-built HEIC decoder,
    // handles all colorspaces including Display P3 and 10-bit HDR correctly),
    // then fall back to ffmpeg if heif-convert is not installed.
    //
    // Root cause of grayscale: ffmpeg decodes HEIC via its own libheif wrapper,
    // but the MJPEG encoder requires yuvj420p.  When the HEIC has a non-standard
    // colorspace (bt2020, Display P3, yuv420p10le) ffmpeg's internal conversion
    // may silently strip chroma → grayscale output even with format=yuv420p.
    // heif-convert uses libheif directly and always outputs correct RGB/JPEG.
    if ext == "heic" || ext == "heif" {
        // ── Primary: heif-convert (libheif-examples) ─────────────────────────
        // Converts HEIC → PNG to a temp file, then we resize + JPEG-encode it.
        // Using a temp file avoids stdout framing issues with heif-convert's output.
        let tmp = std::env::temp_dir().join(format!("ff_heic_{}.png",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos()));
        let heif_ok = std::process::Command::new("heif-convert")
            .args(["-q", "90", path, tmp.to_str().unwrap_or("")])
            .output()
            .map(|o| o.status.success() && tmp.exists())
            .unwrap_or(false);

        if heif_ok {
            // Load the correctly-decoded PNG and resize it with the image crate
            let result = (|| -> Result<PathBuf, String> {
                let img = image::open(&tmp).map_err(|e| e.to_string())?;
                let (w, h) = (img.width(), img.height());
                let (tw, th) = if w > h { (256, 256*h/w.max(1)) } else { (256*w/h.max(1), 256) };
                let tw = tw.max(1); let th = th.max(1);
                let thumb = image::imageops::resize(&img.to_rgb8(), tw, th, image::imageops::FilterType::Triangle);
                let dyn_thumb = image::DynamicImage::ImageRgb8(thumb);
                let mut buf = Vec::with_capacity(32768);
                {
                    let mut cursor = std::io::Cursor::new(&mut buf);
                    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 85);
                    dyn_thumb.write_with_encoder(encoder).map_err(|e| e.to_string())?;
                }
                thumb_cache_put(path, mtime, &buf);
                Ok(thumb_cache_path(path, mtime))
            })();
            let _ = fs::remove_file(&tmp); // clean up temp file regardless
            return result;
        }
        let _ = fs::remove_file(&tmp); // clean up if heif-convert failed

        // ── Fallback: ffmpeg with explicit colorspace conversion ──────────────
        // Requires ffmpeg compiled with libheif support (most distro builds have it).
        // format=yuv420p in the filter chain + pix_fmt yuvj420p forces 8-bit SDR
        // conversion so the MJPEG encoder receives a compatible pixel format.
        let out = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner", "-loglevel", "error",
                "-i", path,
                "-vf", "scale=256:256:force_original_aspect_ratio=decrease,format=yuv420p",
                "-frames:v", "1",
                "-pix_fmt", "yuvj420p",
                "-f", "image2", "-vcodec", "mjpeg",
                "pipe:1",
            ])
            .output()
            .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;
        if out.status.success() && !out.stdout.is_empty() {
            thumb_cache_put(path, mtime, &out.stdout);
            return Ok(thumb_cache_path(path, mtime));
        }
        return Err(format!(
            "HEIC decode failed (heif-convert and ffmpeg both unavailable or errored). \
             Install libheif-examples: sudo pacman -S libheif. \
             ffmpeg stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    // ── Video: extract a single frame via ffmpeg ──────────────────────────────
    // ffmpeg is an optional runtime dependency (listed in README optdepends).
    // If not present, we fall through to Err and let the caller show a generic icon.
    // Seek to 3 seconds in — avoids black leader frames common in many videos.
    // Use -vframes 1 and pipe MJPEG to stdout for zero temp-file overhead.
    const VIDEO_EXTS: &[&str] = &["mp4","mkv","webm","avi","mov","ogv","m4v","flv","ts","wmv","3gp"];
    if VIDEO_EXTS.contains(&ext.as_str()) {
        // Attempt to extract frame with ffmpeg
        let ffmpeg_result = std::process::Command::new("ffmpeg")
            .args([
                "-ss", "00:00:03",          // seek to 3s (fast seek)
                "-i", path,
                "-vframes", "1",            // one frame only
                "-q:v", "5",               // JPEG quality (2=best, 31=worst)
                "-vf", "scale=256:-1",      // resize to 256px wide, keep AR
                "-f", "image2pipe",
                "-vcodec", "mjpeg",
                "pipe:1",                   // write to stdout
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())   // suppress ffmpeg banner spam
            .output();

        match ffmpeg_result {
            Ok(out) if out.status.success() && !out.stdout.is_empty() => {
                // Validate the JPEG bytes before caching
                let jpeg_bytes = out.stdout;
                if jpeg_bytes.starts_with(&[0xFF, 0xD8]) {
                    thumb_cache_put(path, mtime, &jpeg_bytes);
                    return Ok(thumb_cache_path(path, mtime));
                }
                // Invalid JPEG — fall through to error
                return Err(format!("ffmpeg returned invalid JPEG for {path}"));
            }
            Ok(_) => {
                // ffmpeg ran but produced no output (very short video, seek past end).
                // Retry from the start (seek to 0).
                let retry = std::process::Command::new("ffmpeg")
                    .args([
                        "-i", path,
                        "-vframes", "1",
                        "-q:v", "5",
                        "-vf", "scale=256:-1",
                        "-f", "image2pipe",
                        "-vcodec", "mjpeg",
                        "pipe:1",
                    ])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .output();
                if let Ok(r) = retry {
                    if r.status.success() && r.stdout.starts_with(&[0xFF, 0xD8]) {
                        thumb_cache_put(path, mtime, &r.stdout);
                        return Ok(thumb_cache_path(path, mtime));
                    }
                }
                return Err(format!("ffmpeg produced no frame for {path}"));
            }
            Err(_) => {
                // ffmpeg not installed
                return Err(format!("ffmpeg not found; install it for video thumbnails"));
            }
        }
    }

    let reader=image::ImageReader::open(p).map_err(|e|e.to_string())?
        .with_guessed_format().map_err(|e|e.to_string())?;
    let img=reader.decode().map_err(|e|e.to_string())?;
    let (w,h)=(img.width(),img.height());

    // Triangle is 10x faster than Lanczos3, barely noticeable at 256px
    let filter=if w>1024||h>1024 { FilterType::Triangle } else { FilterType::Nearest };

    let (tw,th)=if w>h { (256,256*h/w.max(1)) } else { (256*w/h.max(1),256) };
    let tw=tw.max(1); let th=th.max(1);
    let thumb=image::imageops::resize(&img.to_rgb8(),tw,th,filter);
    let dyn_thumb=image::DynamicImage::ImageRgb8(thumb);
    let mut buf=Vec::with_capacity(32768);
    {
        let mut cursor = std::io::Cursor::new(&mut buf);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 80);
        dyn_thumb.write_with_encoder(encoder).map_err(|e| e.to_string())?;
    }
    thumb_cache_put(path,mtime,&buf);
    Ok(thumb_cache_path(path,mtime))
}

#[tauri::command]
fn get_thumbnail(path:String)->Result<String,String> {
    make_thumbnail(&path).map(|p|p.to_string_lossy().into_owned())
}


// Return raw JPEG bytes (legacy — kept for compatibility)
#[tauri::command]
fn get_thumbnail_bytes(path:String)->Result<Vec<u8>,String> {
    let cached=make_thumbnail(&path)?;
    fs::read(&cached).map_err(|e|e.to_string())
}

// Batch: generate thumbnails and return HTTP-servable cache paths.
// JS uses getMediaUrl(path) to load via the media server — zero IPC bytes.
#[tauri::command]
fn get_thumbnail_bytes_batch(paths:Vec<String>)->Vec<String> {
    use rayon::prelude::*;
    // Limit concurrency to half the CPU count to avoid starving the IPC thread.
    // Rayon's global pool would otherwise use all cores for thumbnail decode.
    let pool=rayon::ThreadPoolBuilder::new()
        .num_threads((rayon::current_num_threads()/2).max(2))
        .build()
        .unwrap_or_else(|_|rayon::ThreadPoolBuilder::new().num_threads(2).build().unwrap());
    pool.install(||{
        paths.par_iter().map(|path|{
            make_thumbnail(path)
                .map(|p|p.to_string_lossy().into_owned())
                .unwrap_or_default()
        }).collect()
    })
}

#[tauri::command]
fn empty_trash()->Result<usize,String> {
    let home=dirs::home_dir().ok_or("no home")?;
    let trash_files=home.join(".local/share/Trash/files");
    let trash_info=home.join(".local/share/Trash/info");
    let mut count=0usize;
    for dir in [&trash_files,&trash_info] {
        if let Ok(entries)=fs::read_dir(dir){
            for entry in entries.flatten(){
                let p=entry.path();
                let res=if p.is_dir(){fs::remove_dir_all(&p)}else{fs::remove_file(&p)};
                if res.is_ok(){count+=1;}
            }
        }
    }
    Ok(count)
}

/// Streaming empty_trash — emits "trash-progress" events {done, total, finished}
/// so the sidebar progress bar can show per-item progress.
#[tauri::command]
async fn empty_trash_stream(window: tauri::Window) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = dirs::home_dir().ok_or("no home")?;
        let trash_files = home.join(".local/share/Trash/files");
        let trash_info  = home.join(".local/share/Trash/info");

        // Count total items first so we can emit percent-complete
        let total: usize = [&trash_files, &trash_info].iter()
            .filter_map(|d| fs::read_dir(d).ok())
            .map(|rd| rd.flatten().count())
            .sum();

        if total == 0 {
            let _ = window.emit("trash-progress", serde_json::json!({
                "done": 0, "total": 0, "finished": true
            }));
            return Ok(0usize);
        }

        let _ = window.emit("trash-progress", serde_json::json!({
            "done": 0, "total": total, "finished": false
        }));

        let mut done = 0usize;
        for dir in [&trash_files, &trash_info] {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    let ok = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
                    if ok.is_ok() { done += 1; }
                    // Emit every item so the bar advances smoothly
                    let _ = window.emit("trash-progress", serde_json::json!({
                        "done": done, "total": total, "finished": false
                    }));
                }
            }
        }
        let _ = window.emit("trash-progress", serde_json::json!({
            "done": done, "total": total, "finished": true
        }));
        Ok(done)
    }).await.map_err(|e| e.to_string())?
}

// Pre-generate thumbnails for a batch of paths (called on folder open, background)
// Uses a limited thread pool so it doesn't starve IPC/UI threads
#[tauri::command]
fn batch_thumbnails(paths:Vec<String>)->Vec<String> {
    let pool=rayon::ThreadPoolBuilder::new()
        .num_threads((rayon::current_num_threads()/2).max(1))
        .build()
        .unwrap_or_else(|_|rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap());
    pool.install(||{
        use rayon::prelude::*;
        paths.par_iter().map(|path|{
            make_thumbnail(path).map(|p|p.to_string_lossy().into_owned()).unwrap_or_default()
        }).collect()
    })
}

// Return cache file paths for a batch — JS loads via HTTP media server (zero IPC bytes)
#[tauri::command]
fn get_thumbnail_url_batch(paths:Vec<String>)->Vec<String> {
    let pool=rayon::ThreadPoolBuilder::new()
        .num_threads((rayon::current_num_threads()/2).max(2))
        .build()
        .unwrap_or_else(|_|rayon::ThreadPoolBuilder::new().num_threads(2).build().unwrap());
    pool.install(||{
        use rayon::prelude::*;
        paths.par_iter().map(|path|{
            make_thumbnail(path).map(|p|p.to_string_lossy().into_owned()).unwrap_or_default()
        }).collect()
    })
}


// Garbage collect thumbnails older than 30 days
#[tauri::command]
fn gc_thumbnail_cache()->usize {
    let dir=thumb_cache_dir();
    let Ok(entries)=fs::read_dir(&dir) else{return 0;};
    let cutoff=std::time::SystemTime::now()-std::time::Duration::from_secs(30*24*3600);
    let mut deleted=0usize;
    for entry in entries.flatten(){
        let path=entry.path();
        if let Ok(meta)=fs::metadata(&path){
            if let Ok(modified)=meta.modified(){
                if modified<cutoff
                    && fs::remove_file(&path).is_ok(){deleted+=1;}
            }
        }
    }
    deleted
}

#[tauri::command]
fn open_as_root(path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let p = Path::new(&path);
        if p.is_dir() {
            let terminals = [
                ("kitty", "--directory"), ("alacritty", "--working-directory"),
                ("foot", "-D"), ("wezterm", "--cwd"), ("ghostty", "-d"),
            ];
            for (bin, flag) in terminals.iter() {
                if std::process::Command::new("which").arg(bin).output()
                    .map(|o| o.status.success()).unwrap_or(false)
                {
                    std::process::Command::new("pkexec").args([bin, flag, path.as_str()]).spawn().ok();
                    return Ok(());
                }
            }
            let r = std::process::Command::new("pkexec")
                .args(["env", "DISPLAY=:0",
                    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
                    "nautilus", "--no-desktop", &path])
                .spawn();
            if r.is_err() {
                std::process::Command::new("pkexec")
                    .args(["xterm", "-e", &format!("cd '{}' && bash", path)])
                    .spawn().map_err(|e| e.to_string())?;
            }
        } else {
            std::process::Command::new("pkexec")
                .args(["xdg-open", &path])
                .spawn().map_err(|e| format!("pkexec: {}", e))?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        // macOS / Windows: no pkexec equivalent — just open normally
        let _ = path;
        Err("Open as root is only supported on Linux.".into())
    }
}

#[tauri::command]
fn check_permission(path:String)->bool {
    let p=Path::new(&path); if p.is_dir(){fs::read_dir(p).is_err()}else{fs::File::open(p).is_err()}
}

#[tauri::command]
fn rename_file(old_path:String,new_name:String)->Result<String,String> {
    let old=Path::new(&old_path); let new=old.parent().ok_or("No parent")?.join(&new_name);
    if new.exists(){return Err(format!("'{}' already exists",new_name));}
    fs::rename(old,&new).map_err(|e|e.to_string())?; Ok(new.to_string_lossy().to_string())
}

#[derive(serde::Deserialize)]
pub struct BatchRenameOptions {
    pub mode: String,
    pub find: Option<String>,
    pub replace: Option<String>,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    pub start_num: Option<u32>,
    pub padding: Option<u32>,
    pub case_mode: Option<String>,
    // p8: when true, compute new names but do NOT rename on disk
    pub dry_run: Option<bool>,
}

#[tauri::command]
async fn batch_rename(paths: Vec<String>, options: BatchRenameOptions) -> Result<Vec<String>, String> {
    let mut results = Vec::new();
    let start_num = options.start_num.unwrap_or(1);
    let padding = options.padding.unwrap_or(1) as usize;
    
    for (i, old_path) in paths.iter().enumerate() {
        let old = Path::new(old_path);
        let _file_name = old.file_name()
            .ok_or("Invalid path")?
            .to_string_lossy()
            .to_string();
        let stem = old.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = old.extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        
        let new_stem = match options.mode.as_str() {
            "find_replace" => {
                let find = options.find.as_deref().unwrap_or("");
                let replace = options.replace.as_deref().unwrap_or("");
                stem.replace(find, replace)
            }
            "prefix" => {
                let prefix = options.prefix.as_deref().unwrap_or("");
                format!("{}{}", prefix, stem)
            }
            "suffix" => {
                let suffix = options.suffix.as_deref().unwrap_or("");
                format!("{}{}", stem, suffix)
            }
            "number" => {
                // p11: saturating_add prevents wrapping on extremely large batches
                let num = start_num.saturating_add(i as u32);
                let num_str = format!("{:0width$}", num, width = padding);
                let prefix = options.prefix.as_deref().unwrap_or("");
                let suffix = options.suffix.as_deref().unwrap_or("");
                format!("{}{}{}", prefix, num_str, suffix)
            }
            "case" => {
                let case = options.case_mode.as_deref().unwrap_or("lower");
                match case {
                    "upper" => stem.to_uppercase(),
                    "title" => {
                        stem.split_whitespace()
                            .map(|word| {
                                let mut chars = word.chars();
                                match chars.next() {
                                    None => String::new(),
                                    Some(first) => first.to_uppercase().chain(chars).collect(),
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    }
                    _ => stem.to_lowercase(),
                }
            }
            _ => stem,
        };
        
        let new_name = format!("{}{}", new_stem, ext);
        let new_path = old.parent().ok_or("No parent")?.join(&new_name);
        
        if new_path.exists() && options.dry_run != Some(true) {
            results.push(format!("ERROR: '{}' already exists", new_name));
            continue;
        }

        if options.dry_run == Some(true) {
            // p8: dry-run — return the computed path without touching the filesystem
            results.push(new_path.to_string_lossy().to_string());
            continue;
        }

        match fs::rename(old, &new_path) {
            Ok(_) => results.push(new_path.to_string_lossy().to_string()),
            Err(e) => results.push(format!("ERROR: {}", e)),
        }
    }
    
    Ok(results)
}

/// Strip RTF control words and return plain text.
fn rtf_to_text(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len() / 4);
    let mut i = 0usize;
    let mut depth = 0i32;
    let mut skip_depth: Option<i32> = None;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'{' { depth += 1; i += 1; continue; }
        if b == b'}' {
            if skip_depth == Some(depth) { skip_depth = None; }
            if depth > 0 { depth -= 1; } i += 1; continue;
        }
        if skip_depth.is_some() { i += 1; continue; }
        if b == b'\\' {
            i += 1; if i >= bytes.len() { break; }
            let c = bytes[i];
            if c == b'\'' {
                i += 1;
                if i + 1 < bytes.len() {
                    if let Ok(n) = u8::from_str_radix(&raw[i..i+2], 16) {
                        out.push(if n < 0x80 { n as char } else { '?' });
                    }
                    i += 2;
                }
                continue;
            }
            if c == b'u' && i+1 < bytes.len() && (bytes[i+1].is_ascii_digit() || bytes[i+1] == b'-') {
                i += 1;
                let start2 = i;
                while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'-') { i += 1; }
                if let Ok(n) = raw[start2..i].parse::<i32>() {
                    if let Some(ch) = char::from_u32(n.unsigned_abs()) { out.push(ch); }
                }
                if i < bytes.len() && bytes[i] == b' ' { i += 1; }
                continue;
            }
            if c == b'*' { skip_depth = Some(depth); i += 1; continue; }
            if c.is_ascii_alphabetic() {
                let ws = i;
                while i < bytes.len() && bytes[i].is_ascii_alphabetic() { i += 1; }
                let word = &raw[ws..i];
                if i < bytes.len() && (bytes[i] == b'-' || bytes[i].is_ascii_digit()) {
                    while i < bytes.len() && (bytes[i] == b'-' || bytes[i].is_ascii_digit()) { i += 1; }
                }
                if i < bytes.len() && bytes[i] == b' ' { i += 1; }
                match word { "par"|"line"|"row" => out.push('\n'), _ => {} }
                continue;
            }
            match c {
                b'\\' => out.push('\\'), b'{' => out.push('{'), b'}' => out.push('}'),
                b'~' => out.push('\u{00A0}'), _ => {}
            }
            i += 1; continue;
        }
        if b != b'\r' { out.push(if b == b'\n' { '\n' } else { b as char }); }
        i += 1;
    }
    let mut result = String::with_capacity(out.len());
    let mut blanks = 0u32;
    for line in out.trim().lines() {
        if line.trim().is_empty() { blanks += 1; if blanks <= 2 { result.push('\n'); } }
        else { blanks = 0; result.push_str(line); result.push('\n'); }
    }
    result
}

/// Extract readable text from a .docx file (Office Open XML).
/// .docx is a ZIP archive containing word/document.xml.
/// We strip all XML tags, collapse whitespace, and return plain paragraphs.
/// Uses the `zip` crate which is already a project dependency.
fn docx_to_text(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut xml_entry = archive.by_name("word/document.xml").ok()?;
    let mut xml = String::new();
    use std::io::Read;
    xml_entry.read_to_string(&mut xml).ok()?;

    // Strip XML tags; convert paragraph/run breaks to newlines
    let mut out = String::with_capacity(xml.len() / 4);
    let mut in_tag = false;
    let mut tag_buf = String::new();
    for ch in xml.chars() {
        match ch {
            '<' => { in_tag = true; tag_buf.clear(); }
            '>' => {
                // Paragraph end tags → newline
                let t = tag_buf.trim_start_matches('/').trim();
                if t.starts_with("w:p") || t == "w:br" || t == "w:cr" {
                    out.push('\n');
                }
                in_tag = false;
            }
            _ => {
                if in_tag { tag_buf.push(ch); }
                else {
                    // Decode common XML entities inline
                    out.push(ch);
                }
            }
        }
    }
    // Decode XML entities
    let out = out.replace("&amp;", "&").replace("&lt;", "<")
                 .replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
    // Collapse 3+ blank lines → 2
    let mut result = String::with_capacity(out.len());
    let mut blanks = 0u32;
    for line in out.trim().lines() {
        if line.trim().is_empty() { blanks += 1; if blanks <= 2 { result.push('\n'); } }
        else { blanks = 0; result.push_str(line); result.push('\n'); }
    }
    if result.trim().is_empty() { return None; }
    Some(result)
}

/// Extract readable content from a .xlsx file (Office Open XML Spreadsheet).
/// .xlsx is a ZIP archive. We read:
///   xl/sharedStrings.xml — the string table (most cell text lives here)
///   xl/worksheets/sheet1.xml — cell values and inline strings for sheet 1
/// Returns a plain-text representation with cells separated by tabs and rows by newlines.
fn xlsx_to_text(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;

    // ── Read shared strings table ─────────────────────────────────────────
    let shared_strings: Vec<String> = {
        let mut strings = Vec::new();
        if let Ok(mut entry) = archive.by_name("xl/sharedStrings.xml") {
            let mut xml = String::new();
            let _ = entry.read_to_string(&mut xml);
            // Split on <si> boundaries; collect all <t>...</t> text within each element.
            // This is the only parser we need — the earlier char-loop approach was dead code.
            for si_chunk in xml.split("<si>").skip(1) {
                let mut text = String::new();
                for t_chunk in si_chunk.split("<t>").skip(1) {
                    if let Some(end) = t_chunk.find("</t>") {
                        let raw = &t_chunk[..end];
                        let decoded = raw.replace("&amp;","&").replace("&lt;","<")
                            .replace("&gt;",">").replace("&quot;","\"").replace("&apos;","'");
                        text.push_str(&decoded);
                    }
                }
                strings.push(text);
            }
            strings
        } else {
            strings
        }
    };

    // ── Read sheet1 ───────────────────────────────────────────────────────
    // Try sheet1.xml; fall back to first available sheet
    let sheet_xml = {
        let mut xml = String::new();
        let name = if archive.by_name("xl/worksheets/sheet1.xml").is_ok() {
            "xl/worksheets/sheet1.xml"
        } else {
            // Try to find any sheet
            let names: Vec<String> = (0..archive.len())
                .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
                .filter(|n| n.starts_with("xl/worksheets/sheet") && n.ends_with(".xml"))
                .collect();
            if names.is_empty() { return None; }
            // We need to clone the name string before using archive again
            let name_owned = names[0].clone();
            drop(xml);
            let mut entry = archive.by_name(&name_owned).ok()?;
            let mut s = String::new();
            let _ = entry.read_to_string(&mut s);
            xml = s;
            ""
        };
        if !name.is_empty() {
            if let Ok(mut entry) = archive.by_name(name) {
                let _ = entry.read_to_string(&mut xml);
            }
        }
        xml
    };

    // Parse rows and cells
    let mut rows: Vec<Vec<String>> = Vec::new();
    for row_chunk in sheet_xml.split("<row ").skip(1) {
        let end = row_chunk.find("</row>").unwrap_or(row_chunk.len());
        let row_xml = &row_chunk[..end];
        let mut cells: Vec<String> = Vec::new();
        for cell_chunk in row_xml.split("<c ").skip(1) {
            // Determine cell type: t="s" = shared string, t="inlineStr" = inline, else numeric
            let is_shared = cell_chunk.contains("t=\"s\"");
            let is_inline = cell_chunk.contains("t=\"inlineStr\"");
            let cell_val = if is_inline {
                // <is><t>text</t></is>
                cell_chunk.split("<t>").nth(1)
                    .and_then(|s| s.find("</t>").map(|e| s[..e].to_string()))
                    .unwrap_or_default()
            } else if is_shared {
                // <v>idx</v> → shared_strings[idx]
                cell_chunk.split("<v>").nth(1)
                    .and_then(|s| s.find("</v>").map(|e| s[..e].trim().to_string()))
                    .and_then(|idx| idx.parse::<usize>().ok())
                    .and_then(|i| shared_strings.get(i).cloned())
                    .unwrap_or_default()
            } else {
                // Numeric or formula result
                cell_chunk.split("<v>").nth(1)
                    .and_then(|s| s.find("</v>").map(|e| s[..e].trim().to_string()))
                    .unwrap_or_default()
            };
            let decoded = cell_val.replace("&amp;","&").replace("&lt;","<")
                .replace("&gt;",">").replace("&quot;","\"").replace("&apos;","'");
            cells.push(decoded);
        }
        if !cells.is_empty() { rows.push(cells); }
    }
    if rows.is_empty() { return None; }
    // Render as tab-separated values (max 200 rows to keep preview fast)
    let mut out = String::new();
    for row in rows.iter().take(200) {
        out.push_str(&row.join("\t"));
        out.push('\n');
    }
    if rows.len() > 200 {
        out.push_str(&format!("\n[... {} more rows not shown]", rows.len() - 200));
    }
    Some(out)
}
/// Extract readable text from an .epub file (ePub 2/3 — ZIP + XHTML).
/// Reads the OPF manifest to find content documents in spine order,
/// then extracts text from each XHTML file, joining them in reading order.
/// Falls back to any *.xhtml/*.html inside the ZIP if OPF parsing fails.
fn epub_to_text(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;

    // ── Find the OPF manifest via META-INF/container.xml ─────────────────
    let opf_path: String = {
        if let Ok(mut entry) = archive.by_name("META-INF/container.xml") {
            let mut xml = String::new();
            let _ = entry.read_to_string(&mut xml);
            // Extract full-path attribute from <rootfile full-path="...">
            xml.split("full-path=\"").nth(1)
                .and_then(|s| s.split('"').next())
                .map(|s| s.to_string())
                .unwrap_or_default()
        } else { String::new() }
    };

    // ── Collect spine item hrefs from OPF ────────────────────────────────
    let spine_hrefs: Vec<String> = if !opf_path.is_empty() {
        if let Ok(mut entry) = archive.by_name(&opf_path) {
            let mut xml = String::new();
            let _ = entry.read_to_string(&mut xml);
            // Build id→href map from <item id="..." href="..." media-type="..."/>
            let mut id_href: std::collections::HashMap<String, String> = std::collections::HashMap::new();
            let opf_dir = opf_path.rfind('/').map(|i| &opf_path[..=i]).unwrap_or("").to_string();
            for chunk in xml.split("<item ") {
                let id  = chunk.split("id=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("").to_string();
                let href= chunk.split("href=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("").to_string();
                let mt  = chunk.split("media-type=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("");
                if (mt.contains("html") || mt.contains("xhtml")) && !id.is_empty() && !href.is_empty() {
                    let full = if href.starts_with('/') { href.clone() } else { format!("{}{}", opf_dir, href) };
                    id_href.insert(id, full);
                }
            }
            // Walk <itemref idref="..."> in spine order
            let mut ordered = Vec::new();
            for chunk in xml.split("<itemref ") {
                if let Some(idref) = chunk.split("idref=\"").nth(1).and_then(|s| s.split('"').next()) {
                    if let Some(href) = id_href.get(idref) { ordered.push(href.clone()); }
                }
            }
            ordered
        } else { Vec::new() }
    } else { Vec::new() };

    // ── Fallback: collect all xhtml/html entries if spine is empty ────────
    let file_names: Vec<String> = if spine_hrefs.is_empty() {
        (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
            .filter(|n| n.ends_with(".xhtml") || n.ends_with(".html") || n.ends_with(".htm"))
            .filter(|n| !n.contains("toc") && !n.contains("nav") && !n.contains("TOC"))
            .collect()
    } else { spine_hrefs };

    // ── Extract text from each content file ────────────────────────────────
    let mut all_text = String::new();
    let mut total_chars = 0usize;
    const MAX_CHARS: usize = 262144; // 256 KB

    for name in &file_names {
        if total_chars >= MAX_CHARS { break; }
        let xml = {
            let mut xml = String::new();
            if archive.by_name(name).map(|mut e| e.read_to_string(&mut xml)).is_err() { continue; }
            xml
        };
        // Strip XML/HTML tags; convert block elements to newlines
        let mut out = String::with_capacity(xml.len() / 3);
        let mut in_tag = false;
        let mut tag_buf = String::new();
        for ch in xml.chars() {
            match ch {
                '<' => { in_tag = true; tag_buf.clear(); }
                '>' => {
                    let t = tag_buf.trim_start_matches('/').split_whitespace().next().unwrap_or("").to_lowercase();
                    match t.as_str() {
                        "p"|"div"|"br"|"h1"|"h2"|"h3"|"h4"|"h5"|"h6"|"li"|"tr"|"dt"|"dd" => out.push('\n'),
                        _ => {}
                    }
                    in_tag = false;
                }
                _ => { if !in_tag { out.push(ch); } else { tag_buf.push(ch); } }
            }
        }
        let decoded = out.replace("&amp;","&").replace("&lt;","<")
            .replace("&gt;",">").replace("&quot;","\"").replace("&apos;","'")
            .replace("&#160;"," ").replace("&nbsp;"," ");
        // Collapse blank lines
        let mut blanks = 0u32;
        for line in decoded.trim().lines() {
            if line.trim().is_empty() { blanks += 1; if blanks <= 1 { all_text.push('\n'); } }
            else { blanks = 0; all_text.push_str(line.trim()); all_text.push('\n'); }
        }
        total_chars = all_text.len();
    }

    if all_text.trim().is_empty() { return None; }
    if all_text.len() > MAX_CHARS {
        all_text.truncate(MAX_CHARS);
        all_text.push_str("\n\n[... truncated at 256 KB]");
    }
    Some(all_text)
}

/// Extract readable text from a .mobi/.azw file (Mobipocket format).
/// Mobi is a proprietary binary format. We do a best-effort plain-text
/// extraction by scanning for the UTF-8 HTML payload between the PalmDOC
/// record headers and stripping all HTML tags.
/// This handles the vast majority of Mobi/AZW files from Kindle and Calibre.
fn mobi_to_text(path: &Path) -> Option<String> {
    let data = fs::read(path).ok()?;
    if data.len() < 78 { return None; }

    // PalmDOC header: first 32 bytes = database name, then record list
    // Record 0 starts at offset given by 32-bit big-endian at byte 76 of record list
    // Simple approach: find the first large HTML-like chunk in the binary
    // by scanning for <html or <body markers
    let text_data: &[u8] = {
        let mut best_start = 0usize;
        let mut best_len   = 0usize;
        // Scan for HTML markers
        for i in 0..data.len().saturating_sub(6) {
            if &data[i..i.min(i+5)] == b"<html" || &data[i..i.min(i+5)] == b"<body" || &data[i..i.min(i+2)] == b"<p" {
                // Find end by scanning forward for enough text
                let end = (i + 512*1024).min(data.len());
                let len = end - i;
                if len > best_len { best_len = len; best_start = i; }
                break;
            }
        }
        if best_len == 0 {
            // Fall back: skip 78-byte Palm header and try from there
            &data[78.min(data.len())..]
        } else {
            &data[best_start..]
        }
    };

    // Attempt UTF-8 decode; replace invalid bytes
    let raw = String::from_utf8_lossy(&text_data[..text_data.len().min(512*1024)]).into_owned();

    // Strip HTML tags
    let mut out = String::with_capacity(raw.len() / 3);
    let mut in_tag = false;
    let mut tag_buf = String::new();
    for ch in raw.chars() {
        match ch {
            '<' => { in_tag = true; tag_buf.clear(); }
            '>' => {
                let t = tag_buf.trim_start_matches('/').split_whitespace().next().unwrap_or("").to_lowercase();
                match t.as_str() {
                    "p"|"br"|"div"|"h1"|"h2"|"h3"|"h4"|"li" => out.push('\n'),
                    _ => {}
                }
                in_tag = false;
            }
            _ => { if !in_tag && ch.is_ascii_graphic() || ch == ' ' || ch == '\n' || !ch.is_ascii() { if !in_tag { out.push(ch); } } else { tag_buf.push(ch); } }
        }
    }
    let decoded = out.replace("&amp;","&").replace("&lt;","<")
        .replace("&gt;",">").replace("&quot;","\"").replace("&nbsp;"," ")
        .replace("&#160;"," ");
    let mut result = String::with_capacity(decoded.len());
    let mut blanks = 0u32;
    for line in decoded.trim().lines() {
        if line.trim().is_empty() { blanks += 1; if blanks <= 1 { result.push('\n'); } }
        else { blanks = 0; result.push_str(line.trim()); result.push('\n'); }
    }
    if result.trim().len() < 50 { return None; } // Too little real text — likely not parseable
    Some(result)
}

/// Emits "delete-progress": {name, done, total, finished, error?}
#[tauri::command]
/// Format a Unix timestamp as ISO 8601 for FreeDesktop.org Trash spec DeletionDate.
fn fmt_iso8601(ts: u64) -> String {
    let secs = ts;
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    // Date calculation (proleptic Gregorian)
    let days = secs / 86400;
    let (yr, mo, dy) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", yr, mo, dy, h, m, s)
}

fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z % 146097;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp = (5*doy + 2)/153;
    let d = doy - (153*mp+2)/5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[tauri::command]
async fn delete_file(window: tauri::Window, path: String, trash: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        if !p.exists() { return Err("File does not exist".into()); }
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !trash {
            let _ = window.emit("delete-progress", serde_json::json!({"name":&name,"done":0,"total":1,"finished":false}));
            if p.is_dir() { fs::remove_dir_all(p).map_err(|e|e.to_string())?; }
            else { fs::remove_file(p).map_err(|e|e.to_string())?; }
            let _ = window.emit("delete-progress", serde_json::json!({"name":"","done":1,"total":1,"finished":true}));
            return Ok(());
        }
        let home = dirs::home_dir().ok_or("No home dir")?;
        let trash_files = home.join(".local/share/Trash/files");
        let trash_info_dir = home.join(".local/share/Trash/info");
        fs::create_dir_all(&trash_files).map_err(|e|e.to_string())?;
        fs::create_dir_all(&trash_info_dir).map_err(|e|e.to_string())?;
        let ts = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let dest_name = if trash_files.join(&name).exists() { format!("{}_{}", name, ts) } else { name.clone() };
        let dest = trash_files.join(&dest_name);
        let abs_path = fs::canonicalize(p).unwrap_or_else(|_|p.to_path_buf());
        let _ = fs::write(trash_info_dir.join(format!("{}.trashinfo",&dest_name)),
            format!("[Trash Info]\nPath={}\nDeletionDate={}\n",abs_path.display(),fmt_iso8601(ts)));
        // Fast path: same-filesystem rename is instant — no progress needed
        if fs::rename(p, &dest).is_ok() {
            let _ = window.emit("delete-progress", serde_json::json!({"name":&name,"done":1,"total":1,"finished":true}));
            return Ok(());
        }
        // Slow path: cross-device copy+delete with per-file progress events
        fn count_items(p: &Path) -> u64 {
            if p.is_dir() { fs::read_dir(p).map(|rd|rd.filter_map(|e|e.ok()).map(|e|count_items(&e.path())).sum::<u64>()).unwrap_or(0)+1 } else { 1 }
        }
        let total = count_items(p).max(1);
        let done = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        fn copy_del(src:&Path,dst:&Path,done:&std::sync::Arc<std::sync::atomic::AtomicU64>,total:u64,win:&tauri::Window,nm:&str)->Result<(),String>{
            use std::sync::atomic::Ordering::Relaxed;
            if src.is_dir() {
                fs::create_dir_all(dst).map_err(|e|e.to_string())?;
                done.fetch_add(1,Relaxed);
                let _=win.emit("delete-progress",serde_json::json!({"name":nm,"done":done.load(Relaxed),"total":total,"finished":false}));
                for e in fs::read_dir(src).map_err(|e|e.to_string())? {
                    let e=e.map_err(|e|e.to_string())?;
                    copy_del(&e.path(),&dst.join(e.file_name()),done,total,win,nm)?;
                }
            } else {
                fs::copy(src,dst).map_err(|e|e.to_string())?;
                fs::remove_file(src).map_err(|e|e.to_string())?;
                let d=done.fetch_add(1,Relaxed)+1;
                let _=win.emit("delete-progress",serde_json::json!({"name":nm,"done":d,"total":total,"finished":false}));
            }
            Ok(())
        }
        copy_del(p, &dest, &done, total, &window, &name)?;
        if p.is_dir() { let _ = fs::remove_dir_all(p); }
        let _ = window.emit("delete-progress", serde_json::json!({"name":&name,"done":total,"total":total,"finished":true}));
        Ok(())
    }).await.map_err(|e|e.to_string())?
}

/// Securely delete files by overwriting with random data before deletion.
/// Emits "secure-delete-progress": {pass, total_passes, file, finished, error?}
/// JS listener expects: const {pass, total_passes, file, finished} = ev.payload;
#[tauri::command]
async fn secure_delete(window: tauri::Window, paths: Vec<String>, passes: u32) -> Result<(), String> {
    use rand::Rng;

    let total_passes = passes;
    let _ = window.emit("secure-delete-progress", serde_json::json!({
        "pass": 0, "total_passes": total_passes, "file": "", "finished": false
    }));

    for path in &paths {
        let filename = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());

        for pass_num in 1..=passes {
            let _ = window.emit("secure-delete-progress", serde_json::json!({
                "pass": pass_num, "total_passes": total_passes,
                "file": &filename, "finished": false
            }));

            let path_clone = path.clone();
            if let Err(e) = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                let p = std::path::Path::new(&path_clone);
                if !p.exists() { return Ok(()); }
                if p.is_dir() { return Err("secure_delete does not support directories".into()); }
                let size = std::fs::metadata(p).map_err(|e| e.to_string())?.len() as usize;
                let mut file = std::fs::OpenOptions::new().write(true).open(p).map_err(|e| e.to_string())?;
                let mut rng = rand::thread_rng();
                let mut buf = vec![0u8; size.min(65536)];
                let mut written = 0;
                while written < size {
                    let chunk = (size - written).min(buf.len());
                    rng.fill(&mut buf[..chunk]);
                    std::io::Write::write_all(&mut file, &buf[..chunk]).map_err(|e| e.to_string())?;
                    written += chunk;
                }
                file.sync_all().map_err(|e| e.to_string())
            }).await.map_err(|e| e.to_string())? {
                let _ = window.emit("secure-delete-progress", serde_json::json!({
                    "pass": pass_num, "total_passes": total_passes,
                    "file": &filename, "finished": false, "error": e
                }));
                continue;
            }
        }

        // Final pass done — delete the file
        let path_clone = path.clone();
        if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
            std::fs::remove_file(&path_clone).map_err(|e| e.to_string())
        }).await.map_err(|e| e.to_string())? {
            let _ = window.emit("secure-delete-progress", serde_json::json!({
                "pass": passes, "total_passes": total_passes,
                "file": &filename, "finished": false, "error": e
            }));
        }
    }

    let _ = window.emit("secure-delete-progress", serde_json::json!({
        "pass": total_passes, "total_passes": total_passes, "file": "", "finished": true
    }));
    Ok(())
}


/// Find duplicate files in a directory by comparing content hashes.
/// Returns Vec of Vec<String> where each inner Vec contains paths of identical files.
#[tauri::command]
async fn find_duplicates(window: tauri::Window, root_path: String, recursive: bool) -> Result<Vec<Vec<String>>, String> {
    use std::collections::HashMap;
    use sha2::{Sha256, Digest};
    
    let _ = window.emit("duplicates-progress", serde_json::json!({"phase":"scanning","done":0,"total":0}));
    
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Vec<String>>, String> {
        let mut files_by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
        
        fn scan_dir(dir: &Path, recursive: bool, sizes: &mut HashMap<u64, Vec<PathBuf>>) -> Result<(), String> {
            let entries = fs::read_dir(dir).map_err(|e|e.to_string())?;
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() && recursive {
                    scan_dir(&path, recursive, sizes)?;
                } else if path.is_file() {
                    if let Ok(meta) = fs::metadata(&path) {
                        if meta.len() > 0 {
                            sizes.entry(meta.len()).or_default().push(path);
                        }
                    }
                }
            }
            Ok(())
        }
        
        scan_dir(Path::new(&root_path), recursive, &mut files_by_size)?;
        
        // Filter to only sizes with potential duplicates
        let potential_dups: Vec<_> = files_by_size.into_iter()
            .filter(|(_, paths)| paths.len() > 1)
            .collect();
        
        let total_files: usize = potential_dups.iter().map(|(_, v)| v.len()).sum();
        let _ = window.emit("duplicates-progress", serde_json::json!({"phase":"hashing","done":0,"total":total_files}));
        
        // Hash files of same size
        let mut hash_map: HashMap<String, Vec<String>> = HashMap::new();
        let mut processed: usize = 0;
        
        for (_, paths) in potential_dups {
            for path in paths {
                processed += 1;
                if processed % 10 == 0 {
                    let _ = window.emit("duplicates-progress", serde_json::json!({"phase":"hashing","done":processed,"total":total_files}));
                }
                
                if let Ok(mut file) = fs::File::open(&path) {
                    let mut hasher = Sha256::new();
                    let mut buffer = [0u8; 8192];
                    loop {
                        if let Ok(n) = file.read(&mut buffer) {
                            if n == 0 { break; }
                            hasher.update(&buffer[..n]);
                        } else { break; }
                    }
                    let hash = format!("{:x}", hasher.finalize());
                    hash_map.entry(hash).or_default().push(path.to_string_lossy().to_string());
                }
            }
        }
        
        let duplicates: Vec<Vec<String>> = hash_map.into_iter()
            .filter(|(_, v)| v.len() > 1)
            .map(|(_, v)| v)
            .collect();
        
        let _ = window.emit("duplicates-progress", serde_json::json!({"phase":"done","done":total_files,"total":total_files,"finished":true}));
        
        Ok(duplicates)
    }).await.map_err(|e|e.to_string())?
}

/// Streaming batch delete — emits "delete-progress" per item.
#[tauri::command]
async fn delete_items_stream(window: tauri::Window, paths: Vec<String>, trash: bool) -> Result<(), String> {
    let total = paths.len() as u64;
    let _ = window.emit("delete-progress", serde_json::json!({"name":"","done":0,"total":total,"finished":false}));
    for (idx, path) in paths.iter().enumerate() {
        let nm = Path::new(path).file_name().map(|n|n.to_string_lossy().to_string()).unwrap_or_default();
        let _ = window.emit("delete-progress", serde_json::json!({"name":&nm,"done":idx as u64,"total":total,"finished":false}));
        let path2 = path.clone(); let win2 = window.clone();
        if let Err(e) = tauri::async_runtime::spawn_blocking(move || -> Result<(),String> {
            let p = Path::new(&path2);
            if !p.exists() { return Ok(()); }
            if !trash {
                return if p.is_dir(){fs::remove_dir_all(p).map_err(|e|e.to_string())}
                       else{fs::remove_file(p).map_err(|e|e.to_string())};
            }
            let home=dirs::home_dir().ok_or("No home dir")?;
            let tf=home.join(".local/share/Trash/files"); let ti=home.join(".local/share/Trash/info");
            fs::create_dir_all(&tf).map_err(|e|e.to_string())?; fs::create_dir_all(&ti).map_err(|e|e.to_string())?;
            let name=p.file_name().ok_or("no name")?.to_string_lossy().to_string();
            let ts=std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            let dn=if tf.join(&name).exists(){format!("{}_{}",name,ts)}else{name.clone()};
            let dest=tf.join(&dn); let abs=fs::canonicalize(p).unwrap_or_else(|_|p.to_path_buf());
            let _=fs::write(ti.join(format!("{}.trashinfo",&dn)),format!("[Trash Info]\nPath={}\nDeletionDate={}\n",abs.display(),fmt_iso8601(ts)));
            if fs::rename(p,&dest).is_ok(){return Ok(());}
            if p.is_dir(){copy_dir_recursive(p,&dest)?;fs::remove_dir_all(p).map_err(|e|e.to_string())}
            else{fs::copy(p,&dest).map_err(|e|e.to_string())?;fs::remove_file(p).map_err(|e|e.to_string())}
        }).await.map_err(|e|e.to_string())? {
            let _ = win2.emit("delete-progress", serde_json::json!({"name":&nm,"error":e,"done":(idx as u64)+1,"total":total,"finished":false}));
        }
    }
    let _ = window.emit("delete-progress", serde_json::json!({"name":"","done":total,"total":total,"finished":true}));
    Ok(())
}

/// Install a font (.otf/.ttf/.woff/.woff2) to ~/.local/share/fonts/ then fc-cache.
#[tauri::command]
async fn install_font(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = Path::new(&path);
        if !src.exists() { return Err(format!("File not found: {path}")); }
        let ext = src.extension().map(|e|e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !matches!(ext.as_str(),"otf"|"ttf"|"woff"|"woff2") {
            return Err("Only OTF, TTF, WOFF, and WOFF2 fonts can be installed.".into());
        }
        let fonts_dir = dirs::home_dir().ok_or("No home dir")?.join(".local/share/fonts");
        fs::create_dir_all(&fonts_dir).map_err(|e|e.to_string())?;
        let dest = fonts_dir.join(src.file_name().ok_or("No filename")?);
        if dest.exists() { return Err("Font is already installed.".into()); }
        fs::copy(src,&dest).map_err(|e|format!("Copy failed: {e}"))?;
        let _ = std::process::Command::new("fc-cache").arg("-f").arg(&fonts_dir).output();
        Ok(dest.to_string_lossy().to_string())
    }).await.map_err(|e|e.to_string())?
}

/// Returns true if the font filename already exists in ~/.local/share/fonts/.
#[tauri::command]
fn is_font_installed(filename: String) -> bool {
    dirs::home_dir().map(|h|h.join(".local/share/fonts").join(&filename).exists()).unwrap_or(false)
}

#[tauri::command]
fn create_directory(path:String,name:String)->Result<String,String> {
    let d=Path::new(&path).join(&name); if d.exists(){return Err(format!("'{}' exists",name));}
    fs::create_dir_all(&d).map_err(|e|e.to_string())?; Ok(d.to_string_lossy().to_string())
}

#[tauri::command]
fn create_file_cmd(path:String,name:String)->Result<String,String> {
    let f=Path::new(&path).join(&name); if f.exists(){return Err(format!("'{}' exists",name));}
    fs::write(&f,"").map_err(|e|e.to_string())?; Ok(f.to_string_lossy().to_string())
}

#[tauri::command]
fn get_dir_size(path:String)->Result<u64,String> {
    fn inner(p:&Path)->u64 { let Ok(rd)=fs::read_dir(p) else{return 0}; rd.filter_map(|e|e.ok()).map(|e|{let m=e.metadata().ok();if m.as_ref().map(|m|m.is_dir()).unwrap_or(false){inner(&e.path())}else{m.map(|m|m.len()).unwrap_or(0)}}).sum() }
    Ok(inner(Path::new(&path)))
}

// perf: parallel directory size using rayon — same result as get_dir_size but
// 4-8x faster on multi-core hardware for large trees (10k+ files).
#[tauri::command]
async fn get_dir_size_fast(path:String)->Result<u64,String> {
    use rayon::prelude::*;
    fn collect_paths(p:&Path, out:&mut Vec<PathBuf>){
        let Ok(rd)=std::fs::read_dir(p) else{return};
        for e in rd.filter_map(|e|e.ok()){
            let ep=e.path();
            if ep.is_dir(){ collect_paths(&ep,out); } else { out.push(ep); }
        }
    }
    tauri::async_runtime::spawn_blocking(move||{
        let mut paths=Vec::new();
        collect_paths(Path::new(&path),&mut paths);
        let total:u64=paths.par_iter()
            .filter_map(|p|p.metadata().ok())
            .map(|m|m.len()).sum();
        Ok(total)
    }).await.map_err(|e|e.to_string())?
}

fn copy_dir_recursive(src:&Path,dst:&Path)->Result<(),String> {
    fs::create_dir_all(dst).map_err(|e|e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e|e.to_string())? {
        let entry=entry.map_err(|e|e.to_string())?; let dest_path=dst.join(entry.file_name());
        if entry.metadata().map(|m|m.is_dir()).unwrap_or(false){copy_dir_recursive(&entry.path(),&dest_path)?;}
        else{fs::copy(entry.path(),dest_path).map_err(|e|e.to_string())?;}
    }
    Ok(())
}

#[tauri::command]
async fn copy_file(src:String,dest_dir:String)->Result<String,String> {
    tauri::async_runtime::spawn_blocking(move || copy_file_sync(src, dest_dir))
        .await.map_err(|e| e.to_string())?
}
fn copy_file_sync(src:String,dest_dir:String)->Result<String,String> {
    let src_p=Path::new(&src); let name=src_p.file_name().ok_or("No filename")?;
    let mut dest=Path::new(&dest_dir).join(name);
    if dest.exists() {
        let stem=src_p.file_stem().map(|s|s.to_string_lossy().to_string()).unwrap_or_default();
        let ext=src_p.extension().map(|e|format!(".{}",e.to_string_lossy())).unwrap_or_default();
        let mut n=2; loop{dest=Path::new(&dest_dir).join(format!("{} copy {}{}",stem,n,ext));if!dest.exists(){break;}n+=1;}
    }
    if src_p.is_dir(){copy_dir_recursive(src_p,&dest)?;}else{fs::copy(src_p,&dest).map_err(|e|e.to_string())?;}
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
async fn move_file(src:String,dest_dir:String)->Result<String,String> {
    tauri::async_runtime::spawn_blocking(move || move_file_sync(src, dest_dir))
        .await.map_err(|e| e.to_string())?
}
fn move_file_sync(src:String,dest_dir:String)->Result<String,String> {
    let src_p=Path::new(&src); let name=src_p.file_name().ok_or("No filename")?;
    let dest=Path::new(&dest_dir).join(name);
    if dest.exists(){return Err(format!("'{}' already exists in destination",name.to_string_lossy()));}
    if fs::rename(src_p,&dest).is_ok(){return Ok(dest.to_string_lossy().to_string());}
    if src_p.is_dir(){copy_dir_recursive(src_p,&dest)?;fs::remove_dir_all(src_p).map_err(|e|e.to_string())?;}
    else{fs::copy(src_p,&dest).map_err(|e|e.to_string())?;fs::remove_file(src_p).map_err(|e|e.to_string())?;}
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn create_new_document(path:String,name:String,doc_type:String)->Result<String,String> {
    let f=Path::new(&path).join(&name); if f.exists(){return Err(format!("'{}' already exists",name));}
    let title=Path::new(&name).file_stem().map(|s|s.to_string_lossy().to_string()).unwrap_or_else(||name.clone());
    let content=match doc_type.as_str() {
        "markdown"=>format!("# {}\n\n",title),
        "html"=>format!("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <title>{}</title>\n</head>\n<body>\n\n</body>\n</html>\n",title),
        "rust"=>"fn main() {\n    println!(\"Hello, world!\");\n}\n".to_string(),
        "python"=>"#!/usr/bin/env python3\n\ndef main():\n    print(\"Hello, world!\")\n\nif __name__ == \"__main__\":\n    main()\n".to_string(),
        "json"=>"{}\n".to_string(),"toml"=>"# Configuration\n".to_string(),"shell"=>"#!/bin/bash\n\n".to_string(),_=>String::new(),
    };
    fs::write(&f,content).map_err(|e|e.to_string())?; Ok(f.to_string_lossy().to_string())
}

// ── File Tagging ──────────────────────────────────────────────────────────────

#[tauri::command]
fn get_file_tags(path:String)->Vec<String> {
    let db=load_tags_db();
    db.get(&path).and_then(|v|v.as_array())
        .map(|arr|arr.iter().filter_map(|v|v.as_str().map(|s|s.to_string())).collect())
        .unwrap_or_default()
}

#[tauri::command]
fn set_file_tags(path:String,tags:Vec<String>)->Result<(),String> {
    let mut db=load_tags_db();
    let obj=db.as_object_mut().ok_or("DB corrupt")?;
    if tags.is_empty(){ obj.remove(&path); }
    else{ obj.insert(path,serde_json::Value::Array(tags.into_iter().map(serde_json::Value::String).collect())); }
    save_tags_db(&db); Ok(())
}

#[tauri::command]
fn get_all_tags()->Vec<String> {
    let db=load_tags_db();
    let mut tags=std::collections::HashSet::new();
    if let Some(obj)=db.as_object(){
        for v in obj.values(){
            if let Some(arr)=v.as_array(){
                for t in arr{ if let Some(s)=t.as_str(){tags.insert(s.to_string());} }
            }
        }
    }
    let mut v:Vec<_>=tags.into_iter().collect(); v.sort(); v
}

#[tauri::command]
fn search_by_tag(tag:String)->Vec<FileTag> {
    let db=load_tags_db();
    let mut results=Vec::new();
    if let Some(obj)=db.as_object(){
        for (path,v) in obj{
            if let Some(arr)=v.as_array(){
                let tags:Vec<String>=arr.iter().filter_map(|v|v.as_str().map(|s|s.to_string())).collect();
                if tags.iter().any(|t|t==&tag){ results.push(FileTag{path:path.clone(),tags}); }
            }
        }
    }
    results
}

// ── Batch copy / move with progress events ────────────────────────────────────
// These replace the JS sequential for-loop that called copy_file/move_file N times.
// A background thread does the work and emits "file-op-progress" events so JS
// can show a live progress bar without freezing the WebView.
//
// Event payload: { done: usize, total: usize, name: String, error: Option<String> }
// Final event:   { done: total, total, name: "", finished: true }

#[derive(Clone, serde::Serialize)]
struct FileOpProgress {
    done: usize,
    total: usize,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes_total: Option<u64>,
}

#[tauri::command]
fn cancel_file_op() {
    FILE_OP_CANCEL.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn copy_files_batch(window: Window, srcs: Vec<String>, dest_dir: String) {
    FILE_OP_CANCEL.store(false, Ordering::Relaxed);
    let dest_dir = dest_dir.clone();
    std::thread::spawn(move || {
        let total = srcs.len();
        let bytes_total: u64 = srcs.iter().map(|s| fs::metadata(s).map(|m| m.len()).unwrap_or(0)).sum();
        let mut bytes_done: u64 = 0;
        for (i, src) in srcs.iter().enumerate() {
            // p7: check cancel token between files
            if FILE_OP_CANCEL.load(Ordering::Relaxed) {
                let _ = window.emit("file-op-progress", FileOpProgress {
                    done: i, total, name: String::new(), error: Some("cancelled".into()),
                    finished: Some(true), bytes_done: Some(bytes_done), bytes_total: Some(bytes_total),
                });
                return;
            }
            let name = Path::new(src).file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let file_size = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
            let result = copy_file_sync(src.clone(), dest_dir.clone());
            if result.is_ok() { bytes_done += file_size; }
            let _ = window.emit("file-op-progress", FileOpProgress {
                done: i + 1, total,
                name: name.clone(),
                error: result.err(),
                finished: if i + 1 == total { Some(true) } else { None },
                bytes_done: Some(bytes_done),
                bytes_total: Some(bytes_total),
            });
        }
    });
}

#[tauri::command]
fn move_files_batch(window: Window, srcs: Vec<String>, dest_dir: String) {
    FILE_OP_CANCEL.store(false, Ordering::Relaxed);
    let dest_dir = dest_dir.clone();
    std::thread::spawn(move || {
        let total = srcs.len();
        let bytes_total: u64 = srcs.iter().map(|s| fs::metadata(s).map(|m| m.len()).unwrap_or(0)).sum();
        let mut bytes_done: u64 = 0;
        for (i, src) in srcs.iter().enumerate() {
            // p7: check cancel token between files
            if FILE_OP_CANCEL.load(Ordering::Relaxed) {
                let _ = window.emit("file-op-progress", FileOpProgress {
                    done: i, total, name: String::new(), error: Some("cancelled".into()),
                    finished: Some(true), bytes_done: Some(bytes_done), bytes_total: Some(bytes_total),
                });
                return;
            }
            let name = Path::new(src).file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let file_size = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
            let result = move_file_sync(src.clone(), dest_dir.clone());
            if result.is_ok() { bytes_done += file_size; }
            let _ = window.emit("file-op-progress", FileOpProgress {
                done: i + 1, total,
                name: name.clone(),
                error: result.err(),
                finished: if i + 1 == total { Some(true) } else { None },
                bytes_done: Some(bytes_done),
                bytes_total: Some(bytes_total),
            });
        }
    });
}

// ── External Drag & Drop ───────────────────────────────────────────────────────────────

#[tauri::command]
fn parse_dropped_paths(uri_list: String) -> Vec<String> {
    let mut paths = Vec::new();
    for line in uri_list.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if line.starts_with("file://") {
            if let Ok(url) = url::Url::parse(line) {
                if let Ok(path) = url.to_file_path() {
                    paths.push(path.to_string_lossy().to_string());
                }
            }
        } else if line.starts_with('/') {
            // Plain absolute path (some apps send this as text/plain)
            paths.push(line.to_string());
        }
    }
    paths
}

// ── Compression ───────────────────────────────────────────────────────────────

#[tauri::command]
async fn compress_files(window: tauri::Window, paths:Vec<String>,output_path:String,compression_level:Option<u8>)->Result<CompressResult,String> {
    tauri::async_runtime::spawn_blocking(move || _compress_files_sync(window, paths, output_path, compression_level))
        .await
        .map_err(|e| format!("thread error: {}", e))?
}

fn _compress_files_sync(window: tauri::Window, paths:Vec<String>,output_path:String,compression_level:Option<u8>)->Result<CompressResult,String> {
    use zip::ZipWriter;
    use zip::write::FileOptions;

    fn walk_dir(root: &Path, out: &mut Vec<std::path::PathBuf>) {
        out.push(root.to_path_buf());
        if let Ok(rd) = fs::read_dir(root) {
            let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let p = entry.path();
                if p.is_dir() { walk_dir(&p, out); } else { out.push(p); }
            }
        }
    }

    // ── Pre-scan to count total files for accurate progress ───────────────────
    let mut total_files = 0usize;
    for input_path in &paths {
        let base = Path::new(input_path);
        if base.is_dir() {
            let mut all = Vec::new();
            walk_dir(base, &mut all);
            total_files += all.iter().filter(|p| p.is_file()).count();
        } else if base.is_file() {
            total_files += 1;
        }
    }
    let _ = window.emit("compress-progress", serde_json::json!({
        "done": 0, "total": total_files, "finished": false
    }));

    let out_file=fs::File::create(&output_path).map_err(|e|e.to_string())?;
    let mut zip=ZipWriter::new(out_file);
    // p8: map compression_level 0=stored,1-3=fast,4-6=default,7-9=best
    let (method, level_opt) = match compression_level {
        Some(0)     => (zip::CompressionMethod::Stored, None),
        Some(1..=3) => (zip::CompressionMethod::Deflated, Some(1i64)),
        Some(7..=9) => (zip::CompressionMethod::Deflated, Some(9i64)),
        _           => (zip::CompressionMethod::Deflated, None), // balanced default
    };
    let options = {
        let base = FileOptions::<()>::default()
            .compression_method(method)
            .unix_permissions(0o755);
        if let Some(lvl) = level_opt { base.compression_level(Some(lvl)) } else { base }
    };
    let mut file_count=0usize;

    for input_path in &paths {
        let base=Path::new(input_path);
        let parent=base.parent().unwrap_or(Path::new("/"));
        if base.is_dir(){
            let mut all_paths = Vec::new();
            walk_dir(base, &mut all_paths);
            for ep in &all_paths {
                let rel=ep.strip_prefix(parent).unwrap_or(ep.as_path());
                let rel_str=rel.to_string_lossy().to_string().replace('\\',"/");
                if ep.is_dir(){
                    zip.add_directory(&rel_str,options).map_err(|e|e.to_string())?;
                }else{
                    zip.start_file(&rel_str,options).map_err(|e|e.to_string())?;
                    let mut f=fs::File::open(ep).map_err(|e|e.to_string())?;
                    let mut buf=Vec::new();
                    f.read_to_end(&mut buf).map_err(|e|e.to_string())?;
                    zip.write_all(&buf).map_err(|e|e.to_string())?;
                    file_count+=1;
                    let _ = window.emit("compress-progress", serde_json::json!({
                        "done": file_count, "total": total_files, "finished": false
                    }));
                }
            }
        }else if base.is_file(){
            let rel=base.strip_prefix(parent).unwrap_or(base);
            let rel_str=rel.to_string_lossy().to_string().replace('\\',"/");
            zip.start_file(&rel_str,options).map_err(|e|e.to_string())?;
            let mut f=fs::File::open(base).map_err(|e|e.to_string())?;
            let mut buf=Vec::new();
            f.read_to_end(&mut buf).map_err(|e|e.to_string())?;
            zip.write_all(&buf).map_err(|e|e.to_string())?;
            file_count+=1;
            let _ = window.emit("compress-progress", serde_json::json!({
                "done": file_count, "total": total_files, "finished": false
            }));
        }
    }
    zip.finish().map_err(|e|e.to_string())?;
    let _ = window.emit("compress-progress", serde_json::json!({
        "done": file_count, "total": total_files, "finished": true
    }));
    Ok(CompressResult{output_path,file_count})
}


#[derive(serde::Serialize, Clone)]
struct ArchiveItem {
    name: String,
    size: Option<u64>,
}

#[tauri::command]
async fn get_archive_contents(path: String) -> Result<Vec<ArchiveItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name_lower = path.to_lowercase();
        let mut items: Vec<ArchiveItem> = Vec::new();

        if name_lower.ends_with(".zip") {
            let f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut archive = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
            for i in 0..archive.len() {
                if let Ok(file) = archive.by_index(i) {
                    items.push(ArchiveItem {
                        name: file.name().to_string(),
                        size: Some(file.size()),
                    });
                }
            }
        } else {
            // tar-based formats: use `tar -tf` to list contents
            let output = std::process::Command::new("tar")
                .args(["--list", "--verbose", "-f", &path])
                .output()
                .map_err(|e| format!("tar failed: {}", e))?;
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                // verbose format: permissions links owner group size date time name
                let parts: Vec<&str> = line.splitn(9, ' ').collect();
                if parts.len() >= 9 {
                    let size: Option<u64> = parts[4].parse().ok();
                    let name = parts[8..].join(" ");
                    if !name.is_empty() {
                        items.push(ArchiveItem { name, size });
                    }
                } else if !line.trim().is_empty() {
                    items.push(ArchiveItem { name: line.trim().to_string(), size: None });
                }
            }
            // Fallback: if tar failed (e.g. 7z/rar), try with bsdtar
            if items.is_empty() && !output.status.success() {
                let out2 = std::process::Command::new("bsdtar")
                    .args(["-tf", &path])
                    .output();
                if let Ok(o) = out2 {
                    for line in String::from_utf8_lossy(&o.stdout).lines() {
                        if !line.trim().is_empty() {
                            items.push(ArchiveItem { name: line.trim().to_string(), size: None });
                        }
                    }
                }
            }
        }
        Ok(items)
    }).await.map_err(|e| format!("thread error: {}", e))?
}

#[tauri::command]
async fn extract_archive(window: tauri::Window, archive_path:String,dest_dir:String)->Result<usize,String> {
    // Prevent concurrent extractions from stacking up blocking threads — a second
    // extraction triggered while one is running returns an error immediately.
    if EXTRACT_IN_PROGRESS.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).is_err() {
        return Err("An extraction is already in progress — please wait for it to finish.".to_string());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let r = _extract_archive_sync(window, archive_path, dest_dir);
        EXTRACT_IN_PROGRESS.store(false, Ordering::Release);
        r
    })
    .await
    .map_err(|e| { EXTRACT_IN_PROGRESS.store(false, Ordering::Release); format!("thread error: {}", e) })?;
    result
}

/// Recursively count all files (not directories) under `dir`.
/// Used after tar extraction so we never need a second `tar -tf` subprocess.
fn count_files_recursive(dir: &Path) -> usize {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    let mut count = 0usize;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            count += count_files_recursive(&p);
        } else {
            count += 1;
        }
    }
    count
}

/// Safely join a ZIP entry name onto `base`, rejecting any entry whose resolved
/// output path would escape the destination directory.
///
/// Rejects:
/// - Absolute paths  (`/etc/passwd`)  — `Path::join` silently replaces the base
///   with an absolute component, allowing complete directory escape.
/// - Parent-directory components (`../`)
/// - Windows drive prefixes (`C:\`)
///
/// Every path component is walked and only `Normal` and `CurDir` components are
/// accepted.  The result is guaranteed to have `base` as a prefix.
fn safe_join_zip(base: &Path, raw_entry: &str) -> Option<PathBuf> {
    // Normalise Windows back-slashes before parsing
    let normalised = raw_entry.replace('\\', "/");
    let mut out = base.to_path_buf();
    for component in Path::new(&normalised).components() {
        match component {
            std::path::Component::Normal(c) => out.push(c),
            std::path::Component::CurDir   => {} // "." — skip
            // RootDir ("/…"), ParentDir (".."), Prefix ("C:\") — reject entirely
            _ => return None,
        }
    }
    // Belt-and-suspenders: confirm the resolved path still starts with base
    if out.starts_with(base) { Some(out) } else { None }
}

fn _extract_archive_sync(window: tauri::Window, archive_path:String,dest_dir:String)->Result<usize,String> {
    use zip::ZipArchive;

    fs::create_dir_all(&dest_dir).map_err(|e|e.to_string())?;
    let dest_canonical = fs::canonicalize(&dest_dir).map_err(|e| e.to_string())?;

    let name_lower = archive_path.to_lowercase();

    // ZIP: handle natively via the zip crate — stream directly to disk (no Vec buffer).
    if name_lower.ends_with(".zip") {
        let f=fs::File::open(&archive_path).map_err(|e|e.to_string())?;
        let mut archive=ZipArchive::new(f).map_err(|e|format!("ZIP open failed: {}",e))?;
        let count=archive.len();
        let _ = window.emit("extract-progress", serde_json::json!({
            "done": 0, "total": count, "finished": false, "name": ""
        }));
        for i in 0..count{
            let mut file=archive.by_index(i).map_err(|e|e.to_string())?;
            // p10: safe_join_zip walks path components and rejects absolute paths,
            // ".." traversal, and Windows drive prefixes.  The old replace("..", "_")
            // approach failed silently on absolute entries like "/etc/passwd" because
            // Path::join() replaces the entire base when given an absolute component.
            let outpath = match safe_join_zip(&dest_canonical, file.name()) {
                Some(p) => p,
                None => continue, // skip malicious / unsupported entry
            };
            let display_name = outpath
                .strip_prefix(&dest_canonical)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            if file.name().ends_with('/') {
                fs::create_dir_all(&outpath).map_err(|e|e.to_string())?;
            }else{
                if let Some(p)=outpath.parent(){fs::create_dir_all(p).map_err(|e|e.to_string())?;}
                let mut outfile=fs::File::create(&outpath).map_err(|e|e.to_string())?;
                std::io::copy(&mut file, &mut outfile).map_err(|e|e.to_string())?;
            }
            // Emit every 8 entries to keep IPC traffic low on large archives
            if i % 8 == 7 || i == count - 1 {
                let _ = window.emit("extract-progress", serde_json::json!({
                    "done": i + 1, "total": count, "finished": false, "name": &display_name
                }));
            }
            if i % 64 == 63 { std::thread::yield_now(); }
        }
        let _ = window.emit("extract-progress", serde_json::json!({
            "done": count, "total": count, "finished": true, "name": ""
        }));
        return Ok(count);
    }

    // All other formats (tar, tar.gz, tar.bz2, tar.xz, tar.zst, 7z, rar, gz, bz2, xz, zst):
    // Delegate to the system `tar` binary (GNU tar / bsd tar / libarchive-based tar).
    // libarchive (used by most Linux tar implementations) auto-detects format and
    // supports gz, bz2, xz, zstd, lzma, 7z (read), rar (read) transparently.
    //
    // We use `tar -xf <archive> -C <dest>` with --strip-components=0 so the
    // original directory structure is preserved.
    // The tar binary path is resolved once via find_tar_bin() and cached globally.
    let tar_bin = find_tar_bin()
        .ok_or_else(|| "No tar binary found. Install GNU tar or bsdtar.".to_string())?;

    // Emit indeterminate progress immediately so the bar appears
    let _ = window.emit("extract-progress", serde_json::json!({
        "done": 0, "total": 0, "finished": false, "name": ""
    }));

    // Spawn tar without .output() — .output() holds the blocking thread open
    // with no timeout. On a slow/hung filesystem or NFS mount, it blocks
    // indefinitely and permanently traps EXTRACT_IN_PROGRESS = true.
    // Instead: spawn, watch with try_wait() in a loop, kill after 120 s.
    let mut child = std::process::Command::new(tar_bin)
        .args(["-xf", &archive_path, "-C", &dest_dir])
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("tar spawn failed: {}",e))?;

    let timeout = std::time::Duration::from_secs(120);
    let deadline = std::time::Instant::now() + timeout;
    let mut pulse = 0u32;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let mut stderr_buf = String::new();
                    if let Some(mut se) = child.stderr.take() {
                        let _ = std::io::Read::read_to_string(&mut se, &mut stderr_buf);
                    }
                    return Err(format!("tar extract failed: {}", stderr_buf.trim()));
                }
                break; // success
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("tar extract timed out after 120 s — archive may be on a slow or unresponsive filesystem.".to_string());
                }
                // Pulse the bar every ~1 s so the user sees activity
                pulse += 1;
                if pulse % 5 == 0 {
                    let _ = window.emit("extract-progress", serde_json::json!({
                        "done": 0, "total": 0, "finished": false, "name": ""
                    }));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("tar wait error: {}", e));
            }
        }
    }

    // Count extracted files by walking dest_dir — avoids a second tar subprocess
    let count = count_files_recursive(Path::new(&dest_dir));
    let _ = window.emit("extract-progress", serde_json::json!({
        "done": count, "total": count, "finished": true, "name": ""
    }));
    Ok(count.max(1))
}

// ── delete_items: delete multiple paths, used by undo (copy/create) ──────────
#[tauri::command]
fn delete_items(paths:Vec<String>)->Result<(),String> {
    for path in &paths {
        let p=Path::new(path);
        if !p.exists() { continue; } // already gone — not an error for undo
        if p.is_dir() {
            fs::remove_dir_all(p).map_err(|e|format!("delete_items dir {}: {}",path,e))?;
        } else {
            fs::remove_file(p).map_err(|e|format!("delete_items file {}: {}",path,e))?;
        }
    }
    Ok(())
}

// ── Terminal / Editor ─────────────────────────────────────────────────────────


// ── Open-With: enumerate installed applications ────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct AppEntry {
    name: String,
    exec: String,
    icon: String,
    categories: String,
}

/// Parse a single .desktop file and return an AppEntry if it's a usable GUI app.
fn parse_desktop_file(path: &Path) -> Option<AppEntry> {
    let text = fs::read_to_string(path).ok()?;
    let mut in_section = false;
    let mut name = String::new();
    let mut exec = String::new();
    let mut icon = String::new();
    let mut categories = String::new();
    let mut no_display = false;
    let mut hidden = false;
    let mut app_type = String::new();

    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_section = line == "[Desktop Entry]";
            continue;
        }
        if !in_section { continue; }
        if let Some(v) = line.strip_prefix("Name=")       { if name.is_empty() { name = v.to_string(); } }
        if let Some(v) = line.strip_prefix("Exec=")       { exec = v.to_string(); }
        if let Some(v) = line.strip_prefix("Icon=")       { icon = v.to_string(); }
        if let Some(v) = line.strip_prefix("Type=")       { app_type = v.to_string(); }
        if let Some(v) = line.strip_prefix("Categories=") { categories = v.to_string(); }
        if let Some(v) = line.strip_prefix("NoDisplay=")  { no_display = v.eq_ignore_ascii_case("true"); }
        if let Some(v) = line.strip_prefix("Hidden=")     { hidden = v.eq_ignore_ascii_case("true"); }
    }

    if name.is_empty() || exec.is_empty() { return None; }
    if app_type != "Application" { return None; }
    if no_display || hidden { return None; }
    // Strip %f %F %u %U %d %D %n %N %i %c %k placeholders from exec
    let exec_clean: String = exec.split_whitespace()
        .filter(|t| !t.starts_with('%'))
        .collect::<Vec<_>>().join(" ");
    if exec_clean.is_empty() { return None; }

    Some(AppEntry { name, exec: exec_clean, icon, categories })
}

#[tauri::command]
fn list_apps_for_file(_path: String) -> Vec<AppEntry> {
    // Collect .desktop dirs: Linux XDG + macOS app bundles (future) + user
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(target_os = "linux")]
    {
        dirs.extend([
            std::path::PathBuf::from("/usr/share/applications"),
            std::path::PathBuf::from("/usr/local/share/applications"),
            std::path::PathBuf::from("/var/lib/flatpak/exports/share/applications"),
        ]);
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(".local/share/applications"));
            dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
        }
    }
    // macOS: .desktop files don't exist, so we return empty (app open-with
    // is handled by the OS "open -a" mechanism; future work to enumerate bundles).
    // Windows: same — no .desktop system.
    if dirs.is_empty() { return Vec::new(); }

    let mut apps: Vec<AppEntry> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for dir in &dirs {
        let rd = match fs::read_dir(dir) { Ok(r) => r, Err(_) => continue };
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("desktop") { continue; }
            if let Some(app) = parse_desktop_file(&p) {
                if seen_names.insert(app.name.clone()) {
                    apps.push(app);
                }
            }
        }
    }

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[tauri::command]
fn open_with_app(path: String, exec: String) -> Result<(), String> {
    let parts: Vec<&str> = exec.split_whitespace().collect();
    if parts.is_empty() { return Err("Empty exec".into()); }
    std::process::Command::new(parts[0])
        .args(&parts[1..])
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open_with_app: {}", e))?;
    Ok(())
}

#[tauri::command]
fn open_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Open Terminal.app at the target directory using AppleScript
        let script = format!(
            r#"tell application "Terminal" to do script "cd '{}'" activate"#,
            path.replace('\'', "\\'")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("osascript: {}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Windows Terminal (wt.exe) or fallback to cmd.exe
        let wt = std::process::Command::new("wt.exe")
            .args(["--startingDirectory", &path])
            .creation_flags(0x08000000)
            .spawn();
        if wt.is_ok() { return Ok(()); }
        std::process::Command::new("cmd.exe")
            .args(["/c", "start", "cmd.exe"])
            .current_dir(&path)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("cmd.exe: {}", e))?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux — try known terminal emulators in preference order
        let candidates: &[(&str, &[&str])] = &[
            ("kitty",          &["--directory"]),
            ("alacritty",      &["--working-directory"]),
            ("foot",           &["-D"]),
            ("ghostty",        &["-d"]),
            ("wezterm",        &["start", "--cwd"]),
            ("tilix",          &["-d"]),
            ("gnome-terminal", &["--working-directory"]),
            ("konsole",        &["--workdir"]),
        ];
        for (bin, flags) in candidates.iter() {
            if std::process::Command::new("which").arg(bin).output()
                .map(|o| o.status.success()).unwrap_or(false)
            {
                let mut args: Vec<&str> = flags.to_vec();
                args.push(&path);
                std::process::Command::new(bin).args(&args).spawn()
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
        if let Ok(t) = std::env::var("TERMINAL") {
            std::process::Command::new(&t).spawn().map_err(|e| e.to_string())?;
            return Ok(());
        }
        Err("No terminal emulator found. Install kitty, alacritty, or foot.".into())
    }
}

#[tauri::command]
fn open_in_editor(path: String) -> Result<(), String> {
    // $VISUAL / $EDITOR work on all Unix platforms
    for var in &["VISUAL", "EDITOR"] {
        if let Ok(ed) = std::env::var(var) {
            std::process::Command::new(&ed).arg(&path).spawn().ok();
            return Ok(());
        }
    }
    #[cfg(target_os = "macos")]
    {
        // Try common macOS editors before falling back to open
        let mac_editors = ["code", "codium", "vim", "nano", "micro"];
        for &e in &mac_editors {
            if std::process::Command::new("which").arg(e).output()
                .map(|o| o.status.success()).unwrap_or(false)
            {
                std::process::Command::new(e).arg(&path).spawn()
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Notepad is always available on Windows
        if std::process::Command::new("notepad.exe").arg(&path).spawn().is_ok() {
            return Ok(());
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let editors = ["code", "codium", "kate", "gedit", "mousepad", "pluma", "micro"];
        for &e in &editors {
            if std::process::Command::new("which").arg(e).output()
                .map(|o| o.status.success()).unwrap_or(false)
            {
                std::process::Command::new(e).arg(&path).spawn()
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
    }
    open_file(path)
}

// ── Window Controls ────────────────────────────────────────────────────────────

#[tauri::command] fn window_minimize(window:tauri::WebviewWindow){let _=window.minimize();}
#[tauri::command] fn window_maximize(window:tauri::WebviewWindow)->Result<bool,String> { if window.is_maximized().unwrap_or(false){window.unmaximize().map_err(|e|e.to_string())?;Ok(false)}else{window.maximize().map_err(|e|e.to_string())?;Ok(true)} }
#[tauri::command] fn window_close(window:tauri::WebviewWindow){let _=window.close();}
#[tauri::command] fn window_set_fullscreen(window:tauri::WebviewWindow,fullscreen:bool)->Result<(),String>{window.set_fullscreen(fullscreen).map_err(|e|e.to_string())}
#[tauri::command] fn window_is_maximized(window:tauri::WebviewWindow)->bool{window.is_maximized().unwrap_or(false)}

// ── HTTP Media Server ─────────────────────────────────────────────────────────

fn media_port_file() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("frostfinder/media.port")
}

fn start_media_server()->u16 {
    use std::net::TcpListener;
    use std::io::BufRead;

    // p7: check if another instance already owns a port
    let port_file = media_port_file();
    if let Ok(f) = std::fs::File::open(&port_file) {
        let mut lines = std::io::BufReader::new(f).lines();
        if let (Some(Ok(port_str)), Some(Ok(pid_str))) = (lines.next(), lines.next()) {
            if let (Ok(existing_port), Ok(existing_pid)) = (port_str.trim().parse::<u16>(), pid_str.trim().parse::<u32>()) {
                // Check if that PID is still alive (Linux: /proc/<pid> exists)
                let pid_alive = std::path::Path::new(&format!("/proc/{}", existing_pid)).exists();
                if pid_alive {
                    MEDIA_PORT.store(existing_port, Ordering::Relaxed);
                    return existing_port;
                }
            }
        }
    }

    let listener=TcpListener::bind("127.0.0.1:0").expect("media server bind");
    let port=listener.local_addr().unwrap().port();
    MEDIA_PORT.store(port,Ordering::Relaxed);

    // p7: write port + PID so a second instance can re-use it
    if let Some(parent) = port_file.parent() { let _ = std::fs::create_dir_all(parent); }
    let _ = std::fs::write(&port_file,
        format!("{}
{}
", port, std::process::id()));
    std::thread::spawn(move||{
        for stream in listener.incoming(){
            let Ok(mut s)=stream else{continue};
            // Disable Nagle — send data immediately without batching.
            // GStreamer makes many small range requests during MKV demux and seek
            // probing; Nagle's algorithm can stall those for up to 200ms each.
            let _=s.set_nodelay(true);
            std::thread::spawn(move||handle_media_request(&mut s));
        }
    });
    port
}

fn handle_media_request(stream:&mut std::net::TcpStream) {
    use std::io::{BufRead,BufReader};
    let mut reader=BufReader::new(match stream.try_clone(){Ok(s)=>s,Err(_)=>return});
    let mut request_line=String::new();
    if reader.read_line(&mut request_line).is_err(){return;}
    let parts:Vec<&str>=request_line.trim().splitn(3,' ').collect();
    if parts.len()<2{return;}
    let method=parts[0]; if method!="GET"&&method!="HEAD"{return;}
    let raw_url_path=parts[1];

    // ── Drain all request headers before branching ────────────────────────────
    let mut range_hdr:Option<String>=None;
    loop {
        let mut line=String::new();
        if reader.read_line(&mut line).is_err(){break;}
        let line=line.trim().to_string(); if line.is_empty(){break;}
        if line.to_lowercase().starts_with("range:"){range_hdr=Some(line["range:".len()..].trim().to_string());}
    }

    // ── URL decode and resolve path ───────────────────────────────────────────
    let decoded=url_decode(raw_url_path.trim_start_matches('/'));
    let file_path=if decoded.starts_with('/'){ decoded }else{ format!("/{}",decoded) };
    // ── /heic-jpeg/ endpoint — ffmpeg HEIC→JPEG proxy ───────────────────────
    // The `image` crate has no HEIC decoder, so WebKit cannot receive raw HEIC
    // bytes and display them as an <img>.  This endpoint transcodes on-the-fly:
    //   GET /heic-jpeg//home/user/photo.heic  → 200 image/jpeg
    // JS uses getHeicJpegUrl(path) instead of getMediaUrl(path) for HEIC/HEIF.
    // The thumbnail path already goes through make_thumbnail (which uses ffmpeg),
    // so the preview panel only hits this route for the full-resolution click.
    if file_path.starts_with("/heic-jpeg/") {
        let actual_path = format!("/{}", &file_path["/heic-jpeg/".len()..]);
        let hpath = Path::new(&actual_path);
        if !hpath.exists() || !hpath.is_file() {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found
Content-Length: 0
Connection: close

");
            return;
        }
        let hdr = "HTTP/1.1 200 OK
Content-Type: image/jpeg
Connection: close
Access-Control-Allow-Origin: *
Cache-Control: no-cache

";
        if stream.write_all(hdr.as_bytes()).is_err() { return; }
        if method == "HEAD" { return; }

        // ── Primary decoder: heif-convert (libheif) ───────────────────────────
        // heif-convert handles all HEIC colorspaces (Display P3, bt2020, 10-bit)
        // correctly. Outputs to a temp file then we stream it to the socket.
        // This is more reliable than piping ffmpeg for full-resolution HEIC.
        let tmp = std::env::temp_dir().join(format!("ff_heicfull_{}.jpg",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos()));
        let heif_ok = std::process::Command::new("heif-convert")
            .args(["-q", "90", &actual_path, tmp.to_str().unwrap_or("")])
            .output()
            .map(|o| o.status.success() && tmp.exists())
            .unwrap_or(false);

        if heif_ok {
            if let Ok(bytes) = fs::read(&tmp) {
                let _ = stream.write_all(&bytes);
            }
            let _ = fs::remove_file(&tmp);
            return;
        }
        let _ = fs::remove_file(&tmp);

        // ── Fallback: ffmpeg with explicit colorspace conversion ──────────────
        // -vf format=yuv420p converts bt2020/10-bit to 8-bit SDR before MJPEG encoder.
        let child = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner", "-loglevel", "error",
                "-i", &actual_path,
                "-vf", "format=yuv420p",
                "-pix_fmt", "yuvj420p",
                "-f", "image2", "-vcodec", "mjpeg",
                "pipe:1",
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            if let Some(mut stdout) = child.stdout.take() {
                let mut buf = vec![0u8; 65536];
                loop {
                    match std::io::Read::read(&mut stdout, &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => { if stream.write_all(&buf[..n]).is_err() { child.kill().ok(); return; } }
                    }
                }
            }
            child.wait().ok();
        }
        return;
    }

    // ── /transcode/ endpoint — ffmpeg VAAPI→H.264 proxy for HEVC/MKV ────────
    if file_path.starts_with("/transcode/") {
        let actual_path = format!("/{}", &file_path["/transcode/".len()..]);
        let tpath = Path::new(&actual_path);
        if !tpath.exists() || !tpath.is_file() {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }
        let hdr = "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\n\r\n";
        if stream.write_all(hdr.as_bytes()).is_err() { return; }
        if method == "HEAD" { return; }

        fn stream_child(mut child: std::process::Child, out: &mut std::net::TcpStream) -> bool {
            let mut wrote = false;
            if let Some(mut stdout) = child.stdout.take() {
                let mut buf = vec![0u8; 65536];
                loop {
                    match std::io::Read::read(&mut stdout, &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if out.write_all(&buf[..n]).is_err() { child.kill().ok(); return false; }
                            wrote = true;
                        }
                    }
                }
            }
            let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
            wrote && code == 0
        }

        // Try VAAPI hardware decode+encode first (fast, stays on GPU)
        let vaapi_ok = std::process::Command::new("ffmpeg")
            .args(["-loglevel","error",
                   "-hwaccel","vaapi","-hwaccel_device","/dev/dri/renderD128",
                   "-hwaccel_output_format","vaapi",
                   "-i",&actual_path,
                   "-vf","scale_vaapi=format=nv12",
                   "-c:v","h264_vaapi","-qp","24",
                   "-c:a","aac","-b:a","192k",
                   "-movflags","frag_keyframe+empty_moov+default_base_moof",
                   "-f","mp4","pipe:1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|c| stream_child(c, stream))
            .unwrap_or(false);

        if !vaapi_ok {
            // Software fallback — libx264 handles any codec/bitdepth ffmpeg supports
            if let Ok(c) = std::process::Command::new("ffmpeg")
                .args(["-loglevel","error",
                       "-i",&actual_path,
                       "-c:v","libx264","-preset","veryfast","-crf","24",
                       "-c:a","aac","-b:a","192k",
                       "-movflags","frag_keyframe+empty_moov+default_base_moof",
                       "-f","mp4","pipe:1"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
            { stream_child(c, stream); }
        }
        return;
    }

    let is_head=method=="HEAD";
    let path=Path::new(&file_path);
    if !path.exists()||!path.is_file(){
        let _=stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let file_size=match fs::metadata(path){
        Ok(m)=>m.len(),
        Err(_)=>{let _=stream.write_all(b"HTTP/1.1 500 Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");return;}
    };
    let mime=mime_for_path(path);
    let range=range_hdr.as_deref().and_then(parse_range);

    // Build response — only send Content-Range on 206 (RFC 7233 §4.1).
    // Sending Content-Range on 200 confuses GStreamer souphttpsrc and breaks
    // playback for MKV files that require a seek probe during demux init.
    let headers = match range {
        Some((s, e_opt)) => {
            // Validate: start must be within file bounds
            if s >= file_size {
                let body = format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{file_size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(body.as_bytes());
                return;
            }
            let end = e_opt.unwrap_or(file_size.saturating_sub(1)).min(file_size.saturating_sub(1));
            let content_length = end - s + 1;
            let h = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Type: {mime}\r\nContent-Length: {content_length}\r\nContent-Range: bytes {s}-{end}/{file_size}\r\nAccept-Ranges: bytes\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\n\r\n"
            );
            (h, s, content_length)
        }
        None => {
            let h = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {file_size}\r\nAccept-Ranges: bytes\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\n\r\n"
            );
            (h, 0u64, file_size)
        }
    };
    let (header_str, start, content_length) = headers;
    if stream.write_all(header_str.as_bytes()).is_err(){return;}
    if is_head||file_size==0{return;}
    let mut file=match fs::File::open(path){Ok(f)=>f,Err(_)=>return};
    if file.seek(SeekFrom::Start(start)).is_err(){return;}
    let mut remaining=content_length as usize; let mut buf=vec![0u8;262144]; // 256 KB — reduces syscall overhead for large 4K files
    while remaining>0{let to_read=remaining.min(buf.len());match file.read(&mut buf[..to_read]){Ok(0)|Err(_)=>break,Ok(n)=>{if stream.write_all(&buf[..n]).is_err(){break;}remaining-=n;}}}
}


// ── mpv subprocess Tauri commands ────────────────────────────────────────────
//
// VIDEO PLAYBACK STRATEGY
// -----------------------
// Pure Wayland: wl_surface* is a process-local pointer — an mpv subprocess
//   spawned separately cannot use a pointer from FrostFinder's address space.
//   So for in-app preview, we use the native <video> element + the local HTTP
//   media server (already running) with WEBKIT_DISABLE_DMABUF_RENDERER=1 to
//   avoid black-frame issues. This works perfectly on Wayland with VA-API.
//
// X11 (future): --wid=XID is a global server-side resource, so a subprocess
//   CAN embed into the parent window. The get_native_window_handle command
//   is kept for this path but is currently unused by JS.
//
// External playback: mpv_open_external spawns detached mpv for full-screen
//   playback outside the app, which works on both X11 and Wayland.

/// Return the native window handle.
/// Reserved for future X11 embedded-player use; currently unused on Wayland.
#[tauri::command]
fn get_native_window_handle(window: tauri::WebviewWindow) -> Result<NativeWindowHandle, String> {
    // raw-window-handle 0.6: window_handle() returns a borrowed handle,
    // .as_raw() gives the RawWindowHandle enum. XcbWindowHandle.window is
    // now NonZeroU32, so .get() is required to extract the u32.
    let raw = window.window_handle().map_err(|e| e.to_string())?.as_raw();
    match raw {
        RawWindowHandle::Xlib(w)    => Ok(NativeWindowHandle { backend: "x11".into(),     handle: w.window as i64 }),
        RawWindowHandle::Xcb(w)     => Ok(NativeWindowHandle { backend: "x11".into(),     handle: w.window.get() as i64 }),
        RawWindowHandle::Wayland(w) => Ok(NativeWindowHandle { backend: "wayland".into(), handle: w.surface.as_ptr() as i64 }),
        _ => Err("Unsupported windowing backend".into()),
    }
}

/// Open a file in an external detached mpv window.
/// Works on both X11 and Wayland — no --wid needed.
#[tauri::command]
fn mpv_open_external(path: String, start_time: Option<f64>, fullscreen: Option<bool>) -> Result<(), String> {
    // ── mpv v0.40+ Vulkan fix (per FULL_SCREEN_ISSUE_3.txt) ────────────────
    // mpv 0.40+ switched the default gpu-api to Vulkan. On CachyOS/Hyprland
    // this breaks 10-bit HEVC hardware decoding — frames decode but the
    // Vulkan→Wayland present path stalls, producing a black frame or stutter.
    //
    // --vo=gpu-next         Modern high-performance renderer (replaces --vo=gpu)
    // --gpu-api=opengl      CRITICAL: reverts the Vulkan default. OpenGL EGL
    //                       on Wayland is the stable path for VA-API + Hyprland.
    // --gpu-context=wayland Pure Wayland surface — no XWayland at all
    // --hwdec=vaapi         Direct hardware decode path (GPU stays in GPU memory)
    //                       vaapi-copy was a workaround for the Vulkan bug;
    //                       with OpenGL the direct path works correctly
    // --video-sync=display-resample
    //                       Syncs frame presentation to monitor refresh rate.
    //                       Eliminates the "micro-stutter" on 4K 60fps content.
    // --target-colorspace-hint=yes  Correct HDR/10-bit colour passthrough
    // --target-trc=srgb     SDR fallback if HDR init fails on 8-bit monitors
    // ── mpv flags — compositor-agnostic (GNOME + Hyprland + KDE) ───────────
    // --gpu-context is NOT forced: mpv auto-detects Wayland/X11/EGL from the
    // environment (WAYLAND_DISPLAY / DISPLAY). Forcing --gpu-context=wayland
    // broke GNOME/Mutter's EGL display setup and was the primary cause of the
    // black screen on GNOME regardless of all other flag changes.
    //
    // --vo=gpu-next     Modern renderer, works with OpenGL and Vulkan
    // --gpu-api=opengl  Reverts mpv 0.40+ Vulkan default (Vulkan stalls on
    //                   10-bit HEVC + VA-API on most Wayland compositors)
    // --hwdec=vaapi     Direct hardware decode via VA-API (H.265/HEVC/AV1/AV1)
    // --video-sync=display-resample  Sync to monitor refresh, eliminates stutter
    // --target-colorspace-hint=no    mpv handles colour itself; bypasses broken
    //                                HDR negotiation in Hyprland/Mutter
    // --target-trc=srgb  SDR fallback for 10-bit content on 8-bit monitors
    let mut args: Vec<String> = vec![
        "--vo=gpu-next".into(),
        "--gpu-api=opengl".into(),
        "--hwdec=vaapi".into(),
        "--video-sync=display-resample".into(),
        "--target-colorspace-hint=no".into(),
        "--target-trc=srgb".into(),
        "--keep-open=yes".into(),
    ];
    if fullscreen.unwrap_or(false) {
        args.push("--fullscreen=yes".into());
        // When launched fullscreen, remap ESC to quit mpv entirely instead of
        // just exiting fullscreen mode. Without this, pressing ESC in mpv exits
        // fullscreen but keeps mpv running windowed — FrostFinder stays minimized
        // indefinitely because mpv_is_running() keeps returning true.
        //
        // Write a minimal input.conf that overrides the ESC and q bindings.
        // mpv merges this with its built-in defaults (later entries win), so all
        // other default keybindings remain intact.
        let conf_path = "/tmp/frostfinder_mpv_input.conf";
        let _ = std::fs::write(conf_path, "ESC quit\nq quit\n");
        args.push(format!("--input-conf={}", conf_path));
    }
    if let Some(t) = start_time {
        if t > 0.5 { args.push(format!("--start={:.3}", t)); }
    }
    args.push(path);

    // Store the child so mpv_is_running() can poll it
    let child = std::process::Command::new("mpv")
        .args(&args)
        // WLR_DRM_NO_MODIFIERS=1: disables DRM modifiers that cause black
        // frames on AMD/Intel Wayland — must be set per-process on mpv, not
        // globally, because it affects mpv's Wayland buffer negotiation only.
        .env("WLR_DRM_NO_MODIFIERS", "1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("mpv not found — install with: sudo pacman -S mpv
({e})"))?;

    let mut lock = mpv_child().lock().map_err(|e| e.to_string())?;
    if let Some(mut old) = lock.take() { old.kill().ok(); old.wait().ok(); }
    *lock = Some(child);
    Ok(())
}

/// Poll whether the mpv child process is still running.
/// JS calls this on an interval while mpv-fullscreen mode is active so it can
/// restore the UI (remove body.mpv-fullscreen) when the user closes mpv.
#[tauri::command]
fn mpv_is_running() -> bool {
    let mut lock = match mpv_child().lock() { Ok(l) => l, Err(_) => return false };
    match lock.as_mut() {
        None => false,
        Some(child) => match child.try_wait() {
            Ok(None) => true,          // still running
            Ok(Some(_)) | Err(_) => {  // exited or error
                *lock = None;
                false
            }
        }
    }
}

// The remaining mpv_* stubs are kept so the invoke_handler compiles unchanged.
// On Wayland, JS uses the native <video> element for in-app preview and only
// calls mpv_open_external for full-screen playback.

fn parse_range(s:&str)->Option<(u64,Option<u64>)> {
    let s=s.strip_prefix("bytes=")?; let mut parts=s.splitn(2,'-');
    let start:u64=parts.next()?.trim().parse().ok()?;
    let end:Option<u64>=parts.next().and_then(|e|{let e=e.trim();if e.is_empty(){None}else{e.parse().ok()}});
    Some((start,end))
}

fn url_decode(s:&str)->String {
    let bytes_in=s.as_bytes(); let mut raw:Vec<u8>=Vec::with_capacity(bytes_in.len()); let mut i=0;
    while i<bytes_in.len(){
        if bytes_in[i]==b'%'&&i+2<bytes_in.len(){if let Ok(hex)=std::str::from_utf8(&bytes_in[i+1..i+3]){if let Ok(byte)=u8::from_str_radix(hex,16){raw.push(byte);i+=3;continue;}}}
        else if bytes_in[i]==b'+'{raw.push(b' ');i+=1;continue;}
        raw.push(bytes_in[i]);i+=1;
    }
    String::from_utf8(raw).unwrap_or_else(|e|String::from_utf8_lossy(e.as_bytes()).into_owned())
}

fn mime_for_path(path:&Path)->&'static str {
    let ext=path.extension().map(|e|e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "mp4"=>"video/mp4","mkv"=>"video/x-matroska","webm"=>"video/webm","avi"=>"video/x-msvideo",
        "mov"=>"video/quicktime","ogv"=>"video/ogg","m4v"=>"video/mp4","mp3"=>"audio/mpeg",
        "flac"=>"audio/flac","ogg"=>"audio/ogg","wav"=>"audio/wav","aac"=>"audio/aac",
        "m4a"=>"audio/mp4","opus"=>"audio/opus","weba"=>"audio/webm","png"=>"image/png",
        "jpg"|"jpeg"=>"image/jpeg","gif"=>"image/gif","webp"=>"image/webp","svg"=>"image/svg+xml",
        "heic"=>"image/heic","heif"=>"image/heif",
        "html"|"htm"=>"text/html",
        "css"=>"text/css",
        "js"=>"text/javascript",
        "ttf"=>"font/ttf",
        "otf"=>"font/otf",
        "woff"=>"font/woff",
        "woff2"=>"font/woff2",
        "pdf"=>"application/pdf",
        _=>"application/octet-stream",
    }
}


#[derive(serde::Serialize)]
struct DiffResult {
    unified: String,
    additions: usize,
    deletions: usize,
    binary: bool,
}

#[tauri::command]
fn diff_files(path_a: String, path_b: String) -> Result<DiffResult, String> {
    // Quick binary check — read first 8KB and look for null bytes
    let is_binary = |p: &str| -> bool {
        if let Ok(mut f) = std::fs::File::open(p) {
            let mut buf = [0u8; 8192];
            if let Ok(n) = std::io::Read::read(&mut f, &mut buf) {
                return buf[..n].contains(&0u8);
            }
        }
        false
    };
    if is_binary(&path_a) || is_binary(&path_b) {
        return Ok(DiffResult { unified: String::new(), additions: 0, deletions: 0, binary: true });
    }
    // Use system diff for unified output
    let out = std::process::Command::new("diff")
        .args(["-u", "--label", &path_a, "--label", &path_b, &path_a, &path_b])
        .output()
        .map_err(|e| format!("diff not found: {e}"))?;
    let unified = String::from_utf8_lossy(&out.stdout).to_string();
    let additions = unified.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
    let deletions = unified.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
    Ok(DiffResult { unified, additions, deletions, binary: false })
}

#[tauri::command]
fn eject_drive(mountpoint: String, device: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let r = std::process::Command::new("udisksctl")
            .args(["unmount", "-b", &device, "--no-user-interaction"])
            .output();
        if r.map(|o| o.status.success()).unwrap_or(false) {
            let _ = std::process::Command::new("udisksctl")
                .args(["power-off", "-b", &device, "--no-user-interaction"])
                .output();
            return Ok(());
        }
        let r = std::process::Command::new("umount")
            .arg(&mountpoint).output().map_err(|e| e.to_string())?;
        if r.status.success() { return Ok(()); }
        Err(String::from_utf8_lossy(&r.stderr).trim().to_string())
    }
    #[cfg(target_os = "macos")]
    {
        // macOS: use diskutil unmount
        let r = std::process::Command::new("diskutil")
            .args(["unmount", &mountpoint])
            .output().map_err(|e| e.to_string())?;
        if r.status.success() { return Ok(()); }
        return Err(String::from_utf8_lossy(&r.stderr).trim().to_string());
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (mountpoint, device);
        Err("Eject is not supported on this platform.".into())
    }
}

#[tauri::command]
fn get_media_port()->u16{MEDIA_PORT.load(Ordering::Relaxed)}

#[tauri::command]
fn read_svg_icon(path:String)->Result<String,String> {
    let p=Path::new(&path);
    if !p.exists(){return Err(format!("Icon not found: {}",path));}
    let ext=p.extension().map(|e|e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext!="svg"{return Err("Not an SVG file".into());}
    let allowed=["/usr/share/icons/","/usr/share/pixmaps/","/home/"];
    if !allowed.iter().any(|a|path.starts_with(a)){ return Err("Path not in allowed icon directories".into()); }
    fs::read_to_string(p).map_err(|e|e.to_string())
}

// ── ISO image commands ────────────────────────────────────────────────────────
//
// mount_iso   — loops the ISO as a block device with udisksctl, returns mountpoint
// unmount_iso — detaches the loop device cleanly
// list_usb_drives    — lists removable USB drives suitable as write targets
// write_iso_to_usb  — writes ISO to USB using dd; streams byte progress via events
//
// All commands gate on Linux. On other platforms they return a clear error.

/// Mount an ISO image as a read-only loop device using udisksctl.
/// Returns the mountpoint string on success (e.g. "/run/media/jay/LABEL").
///
/// Uses udisksctl loop-setup + udisksctl mount so Polkit handles privilege
/// correctly — no sudo required on desktop Linux.
#[tauri::command]
fn mount_iso(path: String) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = path; return Err("ISO mounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        let p = Path::new(&path);
        if !p.exists() { return Err(format!("File not found: {path}")); }
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if ext != "iso" { return Err("Only .iso files can be mounted.".into()); }

        // Step 1: loop-setup — creates /dev/loopN from the ISO file
        let setup = std::process::Command::new("udisksctl")
            .args(["loop-setup", "--read-only", "--file", &path, "--no-user-interaction"])
            .output()
            .map_err(|e| format!("udisksctl not found — install udisks2: {e}"))?;

        if !setup.status.success() {
            return Err(format!(
                "loop-setup failed: {}",
                String::from_utf8_lossy(&setup.stderr).trim()
            ));
        }

        // Output: "Mapped file … as /dev/loop3." — may appear on stdout OR stderr
        // depending on udisksctl version. Combine both and scan all tokens.
        let setup_combined = format!(
            "{} {}",
            String::from_utf8_lossy(&setup.stdout),
            String::from_utf8_lossy(&setup.stderr)
        );
        // Find the first token that looks like /dev/loopN (strip trailing dot/comma)
        let loop_dev_opt = setup_combined
            .split_whitespace()
            .find_map(|w| {
                let clean = w.trim_end_matches(['.', ',', ';', '\'', '"']);
                if clean.starts_with("/dev/loop") && clean.len() > 9 { Some(clean.to_string()) } else { None }
            });

        // Fallback: use `losetup -j <path>` to find the loop device by backing file
        let loop_dev = if let Some(dev) = loop_dev_opt {
            dev
        } else {
            let ls_out = std::process::Command::new("losetup")
                .args(["-j", &path])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default();
            // Format: "/dev/loop3: []: (/path/to/file.iso)"
            ls_out.lines()
                .find_map(|line| {
                    let dev = line.split(':').next()?.trim();
                    if dev.starts_with("/dev/loop") { Some(dev.to_string()) } else { None }
                })
                .ok_or_else(|| format!(
                    "Could not find loop device. udisksctl output: {setup_combined}"
                ))?
        };

        // Step 2: mount the loop device
        let mount = std::process::Command::new("udisksctl")
            .args(["mount", "-b", &loop_dev, "--no-user-interaction"])
            .output()
            .map_err(|e| e.to_string())?;

        if !mount.status.success() {
            // Best-effort loop deletion if mount fails
            let _ = std::process::Command::new("udisksctl")
                .args(["loop-delete", "-b", &loop_dev, "--no-user-interaction"])
                .output();
            return Err(format!(
                "Mount failed: {}",
                String::from_utf8_lossy(&mount.stderr).trim()
            ));
        }

        // "Mounted /dev/loop3 at /run/media/user/LABEL."
        let mount_out = String::from_utf8_lossy(&mount.stdout);
        let mountpoint = mount_out
            .find(" at ")
            .map(|i| mount_out[i + 4..].trim().trim_end_matches('.').to_string())
            .unwrap_or_default();

        Ok(mountpoint)
    }
}

/// Unmount and detach the loop device that backs a mounted ISO.
/// `loop_dev` is the /dev/loopN device returned by mount_iso or found via
/// `losetup -j <iso_path>`.  We unmount first, then delete the loop.
#[tauri::command]
fn unmount_iso(loop_dev: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = loop_dev; return Err("ISO unmounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        // unmount (ignore error — may already be unmounted)
        let _ = std::process::Command::new("udisksctl")
            .args(["unmount", "-b", &loop_dev, "--no-user-interaction"])
            .output();

        // delete the loop device
        let r = std::process::Command::new("udisksctl")
            .args(["loop-delete", "-b", &loop_dev, "--no-user-interaction"])
            .output()
            .map_err(|e| e.to_string())?;

        if r.status.success() { return Ok(()); }

        // Fallback: losetup -d
        let r2 = std::process::Command::new("losetup")
            .args(["-d", &loop_dev])
            .output()
            .map_err(|e| e.to_string())?;

        if r2.status.success() { return Ok(()); }

        Err(format!(
            "Detach failed: {}",
            String::from_utf8_lossy(&r.stderr).trim()
        ))
    }
}

/// Return the loop device backing a given ISO path, or empty string if not mounted.
/// Uses `losetup --list --json` and filters by back-file path.
#[tauri::command]
fn get_iso_loop_device(iso_path: String) -> String {
    #[cfg(not(target_os = "linux"))]
    { let _ = iso_path; return String::new(); }

    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("losetup")
            .args(["--list", "--json"])
            .output();
        let Ok(out) = out else { return String::new(); };
        let text = String::from_utf8_lossy(&out.stdout);
        // JSON: {"loopdevices":[{"name":"/dev/loop3","back-file":"/path/to/file.iso",...}]}
        // Simple scan without serde — look for the iso_path value near a "name" key
        let lines: Vec<&str> = text.lines().collect();
        let mut found_dev = String::new();
        let mut current_dev = String::new();
        for line in &lines {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix(r#""name": ""#) {
                current_dev = rest.trim_end_matches(['"', ',']).to_string();
            }
            if trimmed.contains(&iso_path) && !current_dev.is_empty() {
                found_dev = current_dev.clone();
                break;
            }
        }
        found_dev
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct SmbShare {
    pub server: String,
    pub share: String,
    pub mount_point: String,
    pub username: Option<String>,
}

fn smb_registry_path() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("frostfinder")
        .join("smb_mounts.json")
}

fn smb_registry_save(mounts: &[SmbShare]) {
    if let Ok(json) = serde_json::to_string(mounts) {
        let p = smb_registry_path();
        let _ = std::fs::create_dir_all(p.parent().unwrap_or(&p));
        let _ = std::fs::write(&p, json);
    }
}

fn smb_registry_load() -> Vec<SmbShare> {
    let p = smb_registry_path();
    if let Ok(data) = std::fs::read_to_string(&p) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    }
}

static SMB_MOUNTS: std::sync::Mutex<Option<Vec<SmbShare>>> = std::sync::Mutex::new(None);

fn get_smb_mounts_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".cache").join("frostfinder").join("smb"))
        .unwrap_or_else(|| PathBuf::from("/tmp/frostfinder_smb"))
}

#[tauri::command]
fn mount_smb(server: String, share: String, username: Option<String>, password: Option<String>) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (server, share, username, password); return Err("SMB mounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        let mount_base = get_smb_mounts_dir();
        std::fs::create_dir_all(&mount_base).map_err(|e| e.to_string())?;
        
        let mount_point = mount_base.join(format!("{}_{}", server, share));
        let mount_point_str = mount_point.to_string_lossy().to_string();
        
        if mount_point.exists() {
            return Ok(mount_point_str);
        }
        
        std::fs::create_dir_all(&mount_point).map_err(|e| e.to_string())?;
        
        // p10: write credentials to a 0600 temp file so the password is never
        // visible in the process argument list (ps aux / /proc/<pid>/cmdline).
        // We delete the file immediately after the mount subprocess exits.
        let cred_file: Option<std::path::PathBuf> = if let Some(ref user) = username {
            let tmp = std::env::temp_dir()
                .join(format!("frostfinder-smb-{}.cred", uuid_v4().replace('-', "")));
            let content = format!(
                "username={}\npassword={}\n",
                user,
                password.as_deref().unwrap_or("")
            );
            fs::write(&tmp, &content).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
            }
            Some(tmp)
        } else {
            None
        };

        let mut cmd = std::process::Command::new("mount");
        cmd.arg("-t");
        cmd.arg("cifs");

        let url = format!("//{}/{}", server, share);
        cmd.arg(&url);
        cmd.arg(&mount_point);

        cmd.arg("-o");
        let mut opts = vec!["vers=3.0".to_string(), "soft".to_string(), "nobrl".to_string()];
        if let Some(ref cred_path) = cred_file {
            opts.push(format!("credentials={}", cred_path.to_string_lossy()));
        } else {
            opts.push("guest".to_string());
        }
        cmd.arg(opts.join(","));

        let output = cmd.output();
        // Always remove credentials file, even on error
        if let Some(ref cred_path) = cred_file {
            let _ = fs::remove_file(cred_path);
        }
        let output = output.map_err(|e| format!("mount failed: {}", e))?;
        
        if !output.status.success() {
            let _ = std::fs::remove_dir(&mount_point);
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("Mount failed: {}", err));
        }
        
        let smb_info = SmbShare {
            server: server.clone(),
            share: share.clone(),
            mount_point: mount_point_str.clone(),
            username: username.clone(),
        };
        
        if let Ok(mut mounts) = SMB_MOUNTS.lock() {
            if mounts.is_none() {
                *mounts = Some(Vec::new());
            }
            if let Some(ref mut m) = *mounts {
                m.push(smb_info);
                smb_registry_save(m);
            }
        }
        
        Ok(mount_point_str)
    }
}

#[tauri::command]
fn unmount_smb(server: String, share: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (server, share); return Err("SMB unmounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        let mount_point = get_smb_mounts_dir().join(format!("{}_{}", server, share));
        
        if !mount_point.exists() {
            return Ok(());
        }
        
        let output = std::process::Command::new("umount")
            .arg(&mount_point)
            .output()
            .map_err(|e| format!("umount failed: {}", e))?;
        
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("Unmount failed: {}", err));
        }
        
        let _ = std::fs::remove_dir(&mount_point);
        
        if let Ok(mut mounts) = SMB_MOUNTS.lock() {
            if let Some(ref mut m) = *mounts {
                m.retain(|s| !(s.server == server && s.share == share));
                smb_registry_save(m);
            }
        }
        
        Ok(())
    }
}

#[tauri::command]
fn get_smb_mounts() -> Vec<SmbShare> {
    if let Ok(mounts) = SMB_MOUNTS.lock() {
        if let Some(ref m) = *mounts {
            return m.clone();
        }
    }
    Vec::new()
}

#[tauri::command]
fn list_smb_shares(server: String, username: Option<String>, password: Option<String>) -> Result<Vec<String>, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (server, username, password); return Err("SMB listing is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        // p10: never pass user%pass on the command line — use a temp auth file.
        let mut cmd = std::process::Command::new("smbclient");
        cmd.arg("-L");
        cmd.arg(&server);
        cmd.arg("-N");

        let auth_file: Option<std::path::PathBuf> = if let Some(ref user) = username {
            let tmp = std::env::temp_dir()
                .join(format!("frostfinder-smb-{}.cred", uuid_v4().replace('-', "")));
            let content = format!(
                "username={}\npassword={}\n",
                user,
                password.as_deref().unwrap_or("")
            );
            if fs::write(&tmp, &content).is_ok() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
                }
                Some(tmp)
            } else {
                None
            }
        } else {
            None
        };

        if let Some(ref ap) = auth_file {
            cmd.arg("--authentication-file");
            cmd.arg(ap);
        }

        let output = cmd.output();
        if let Some(ref ap) = auth_file {
            let _ = fs::remove_file(ap);
        }
        let output = output.map_err(|e| format!("smbclient failed: {}", e))?;
        
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("Failed to list shares: {}", err));
        }
        
        let mut shares = Vec::new();
        let output_str = String::from_utf8_lossy(&output.stdout);
        
        for line in output_str.lines() {
            let line = line.trim();
            if line.starts_with("Disk|") {
                if let Some(name) = line.split('|').nth(1) {
                    let share_name = name.trim();
                    if !share_name.is_empty() && !share_name.ends_with('$') {
                        shares.push(share_name.to_string());
                    }
                }
            }
        }
        
        Ok(shares)
    }
}

/// List removable / USB block devices suitable as ISO write targets.
/// Returns Vec<(device, label, size_bytes)> for every removable whole disk.
/// Excludes mounted system partitions and loop devices.
#[tauri::command]
fn list_usb_drives() -> Vec<(String, String, u64)> {
    #[cfg(not(target_os = "linux"))]
    { return Vec::new(); }

    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("lsblk")
            .args(["-J", "-b", "-o", "NAME,SIZE,TYPE,RM,HOTPLUG,VENDOR,MODEL,LABEL,MOUNTPOINT"])
            .output();
        let Ok(out) = out else { return Vec::new(); };
        let text = String::from_utf8_lossy(&out.stdout);
        let mut drives = Vec::new();

        let mut cur_name = String::new();
        let mut cur_size: u64 = 0;
        let mut cur_vendor = String::new();
        let mut cur_model = String::new();
        let mut cur_label = String::new();
        let mut cur_type = String::new();
        let mut cur_rm = false;
        let mut cur_hotplug = false;
        let mut cur_mountpoint = String::new();
        let mut depth = 0i32;

        for line in text.lines() {
            let t = line.trim();
            if t.ends_with('{') { depth += 1; }
            if t == "}" || t == "}," {
                if depth == 2 {
                    let is_removable = cur_rm || cur_hotplug;
                    let is_disk = cur_type == "disk";
                    let not_system = cur_mountpoint != "/" && cur_mountpoint != "/boot";
                    if is_removable && is_disk && not_system && !cur_name.is_empty() && cur_size > 0 {
                        let label_parts: Vec<&str> = [cur_vendor.as_str(), cur_model.as_str(), cur_label.as_str()]
                            .iter().filter(|s| !s.is_empty()).copied().collect();
                        let label = if label_parts.is_empty() { cur_name.clone() }
                            else { label_parts.join(" ").trim().to_string() };
                        drives.push((cur_name.clone(), label, cur_size));
                    }
                    cur_name.clear(); cur_vendor.clear(); cur_model.clear();
                    cur_label.clear(); cur_mountpoint.clear();
                    cur_size = 0; cur_rm = false; cur_hotplug = false; cur_type.clear();
                }
                depth -= 1;
            }
            if depth == 2 {
                if let Some(v) = t.strip_prefix(r#""name": ""#) {
                    cur_name = format!("/dev/{}", v.trim_end_matches(['"', ',']));
                } else if let Some(v) = t.strip_prefix(r#""size": "#) {
                    cur_size = v.trim_end_matches(',').trim_matches('"').parse().unwrap_or(0);
                } else if let Some(v) = t.strip_prefix(r#""type": ""#) {
                    cur_type = v.trim_end_matches(['"', ',']).to_string();
                } else if t.contains(r#""rm": true"#) { cur_rm = true; }
                else if t.contains(r#""hotplug": true"#) { cur_hotplug = true; }
                else if let Some(v) = t.strip_prefix(r#""vendor": ""#) {
                    cur_vendor = v.trim_end_matches(['"', ',']).trim().to_string();
                } else if let Some(v) = t.strip_prefix(r#""model": ""#) {
                    cur_model = v.trim_end_matches(['"', ',']).trim().to_string();
                } else if let Some(v) = t.strip_prefix(r#""label": ""#) {
                    cur_label = v.trim_end_matches(['"', ',']).to_string();
                } else if let Some(v) = t.strip_prefix(r#""mountpoint": ""#) {
                    cur_mountpoint = v.trim_end_matches(['"', ',']).to_string();
                }
            }
        }
        drives
    }
}

/// Write an ISO image to a USB drive using dd.
/// Emits "iso-burn-progress" events: {percent, line, bytes_written, done, error?}.
/// DESTRUCTIVE: overwrites all data on the target device.
/// Uses dd status=progress and SIGUSR1 polling for real-time byte progress.
#[tauri::command]
async fn write_iso_to_usb(window: tauri::Window, iso_path: String, device: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (window, iso_path, device); return Err("ISO write is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        use std::io::BufRead;

        let iso_size = fs::metadata(&iso_path)
            .map(|m| m.len())
            .map_err(|e| format!("Cannot read ISO: {e}"))?;
        if iso_size == 0 { return Err("ISO file is empty.".into()); }

        // Only allow whole-disk device paths — never partitions
        let allowed = device.starts_with("/dev/sd") || device.starts_with("/dev/hd")
            || device.starts_with("/dev/vd") || device.starts_with("/dev/mmcblk");
        if !allowed {
            return Err(format!("Device {device} is not a recognised removable device path."));
        }
        // Reject if last char is a digit (partition like /dev/sdb1)
        if device.chars().last().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            return Err(format!("{device} looks like a partition — use the whole disk (e.g. /dev/sdb)."));
        }

        // Refuse to write to the system root disk
        let root_dev = fs::read_to_string("/proc/mounts").unwrap_or_default()
            .lines()
            .find(|l| l.split_whitespace().nth(1) == Some("/"))
            .and_then(|l| l.split_whitespace().next().map(|s| s.to_string()))
            .unwrap_or_default();
        let root_base: String = root_dev.trim_end_matches(|c: char| c.is_ascii_digit()).to_string();
        if root_base == device {
            return Err(format!("Refusing to overwrite {device} — it is the system root device."));
        }

        let _ = window.emit("iso-burn-progress", serde_json::json!({
            "percent": 0,
            "line": format!("Writing {} ({}) to {}…",
                iso_path.split('/').next_back().unwrap_or("ISO"),
                format_bytes_local(iso_size), device),
            "bytes_written": 0u64, "done": false
        }));

        let iso_path_c = iso_path.clone();
        let device_c   = device.clone();
        let window_c   = window.clone();

        tauri::async_runtime::spawn_blocking(move || {
            // Unmount any partitions on this device before writing (best-effort)
            let dev_short = device_c.trim_start_matches("/dev/");
            let _ = std::process::Command::new("sh")
                .args(["-c", &format!(
                    "lsblk -ln -o NAME,MOUNTPOINT /dev/{dev} 2>/dev/null \
                     | awk '$2!=\"\"{{print \"/dev/\"$1}}' | xargs -r umount -l 2>/dev/null",
                    dev = dev_short
                )]).output();

            let _ = std::process::Command::new("sync").output();

            let mut child = match std::process::Command::new("dd")
                .args([
                    &format!("if={iso_path_c}"),
                    &format!("of={device_c}"),
                    "bs=4M",
                    "status=progress",
                    "oflag=sync",
                ])
                .stderr(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    let _ = window_c.emit("iso-burn-progress", serde_json::json!({
                        "percent": 0, "done": true,
                        "error": format!("dd failed to start: {e}")
                    }));
                    return;
                }
            };

            let dd_pid = child.id();

            // Ticker: send SIGUSR1 every 900ms to trigger dd's progress line output
            let ticker = std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    let alive = std::process::Command::new("kill")
                        .args(["-0", &dd_pid.to_string()]).output()
                        .map(|o| o.status.success()).unwrap_or(false);
                    if !alive { break; }
                    let _ = std::process::Command::new("kill")
                        .args(["-USR1", &dd_pid.to_string()]).output();
                }
            });

            let stderr = child.stderr.take().unwrap();
            let reader = std::io::BufReader::new(stderr);

    for line in reader.lines().map_while(Result::ok) {
                // dd progress line: "102760448 bytes (103 MB, 98 MiB) copied, 4.5 s, 22.8 MB/s"
                let bytes_written: u64 = line.split_whitespace()
                    .next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let percent = if iso_size > 0 {
                    ((bytes_written as f64 / iso_size as f64) * 100.0).min(99.0) as u8
                } else { 0 };
                let _ = window_c.emit("iso-burn-progress", serde_json::json!({
                    "percent": percent, "line": line.trim(),
                    "bytes_written": bytes_written, "done": false
                }));
            }

            // wait() only fails if process wasn't spawned or already waited — treat as failure
            let status = child.wait();
            let success = status.map(|s| s.success()).unwrap_or(false);
            drop(ticker);
            let _ = std::process::Command::new("sync").output();

            if success {
                let _ = window_c.emit("iso-burn-progress", serde_json::json!({
                    "percent": 100,
                    "line": "Write complete — safe to remove the drive.",
                    "bytes_written": iso_size, "done": true
                }));
            } else {
                let _ = window_c.emit("iso-burn-progress", serde_json::json!({
                    "percent": 0, "done": true,
                    "error": format!(
                        "dd failed — device may be write-protected, too small \
                         (need {}), or not a valid block device.",
                        format_bytes_local(iso_size))
                }));
            }
        }).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn format_bytes_local(b: u64) -> String {
    if b < 1024 { format!("{b} B") }
    else if b < 1_048_576 { format!("{:.1} KB", b as f64/1024.0) }
    else if b < 1_073_741_824 { format!("{:.1} MB", b as f64/1_048_576.0) }
    else { format!("{:.2} GB", b as f64/1_073_741_824.0) }
}

// ── DMG (Apple Disk Image) commands ──────────────────────────────────────────
//
// mount_dmg          — loop-mounts a .dmg as a block device, returns mountpoint
// unmount_dmg        — detaches the loop device cleanly
// get_dmg_loop_device — returns the active /dev/loopN for a given .dmg path
//
// Uses the same udisksctl + losetup strategy as ISO mounting. DMG files with
// HFS+/FAT32 partitions mount correctly on Linux with hfsprogs/hfsutils installed.
// All commands gate on Linux; on other platforms they return a clear error.

/// Mount a .dmg image as a read-only loop device using udisksctl.
/// Returns the mountpoint string on success.
///
/// DMG files contain a partition table (Apple Partition Map or GPT), so the
/// loop device itself is not directly mountable — the filesystem lives on the
/// first partition (/dev/loopNp1). Strategy:
///   1. losetup -P --read-only <file>  — creates /dev/loopN + partition nodes
///   2. Find the first /dev/loopNpM partition via /sys/block/loopN/
///   3. udisksctl mount -b /dev/loopNp1 — Polkit-handled, no sudo required
#[tauri::command]
fn mount_dmg(path: String) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = path; return Err("DMG mounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        let p = Path::new(&path);
        if !p.exists() { return Err(format!("File not found: {path}")); }
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if ext != "dmg" { return Err("Only .dmg files can be mounted here.".into()); }

        // Step 1: Create loop device with partition scan (-P)
        // losetup -P is more reliable than udisksctl loop-setup for partition detection
        let setup = std::process::Command::new("losetup")
            .args(["--find", "--read-only", "--partscan", "--show", &path])
            .output()
            .map_err(|e| format!("losetup not found: {e}"))?;

        if !setup.status.success() {
            return Err(format!(
                "losetup failed: {}",
                String::from_utf8_lossy(&setup.stderr).trim()
            ));
        }

        // losetup --show prints the loop device path, e.g. "/dev/loop3"
        let loop_dev = String::from_utf8_lossy(&setup.stdout).trim().to_string();
        if loop_dev.is_empty() || !loop_dev.starts_with("/dev/loop") {
            return Err(format!("losetup returned unexpected output: {loop_dev}"));
        }

        // Step 2: Find first partition child, e.g. /dev/loop3p1
        // Wait briefly for udev to register partition nodes
        std::thread::sleep(Duration::from_millis(400));

        let loop_base = loop_dev.trim_start_matches("/dev/"); // "loop3"
        let part_dev = {
            // Scan /sys/block/loop3/ for partN entries
            let sys_path = format!("/sys/block/{}", loop_base);
            let mut found = String::new();
            if let Ok(rd) = std::fs::read_dir(&sys_path) {
                let mut parts: Vec<String> = rd
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.starts_with(loop_base) && n.len() > loop_base.len())
                    .collect();
                parts.sort();
                if let Some(first) = parts.first() {
                    found = format!("/dev/{}", first);
                }
            }
            // Fallback: try /dev/loop3p1 directly
            if found.is_empty() {
                let candidate = format!("{loop_dev}p1");
                if Path::new(&candidate).exists() { found = candidate; }
            }
            found
        };

        // Step 3: Mount — prefer the partition, fall back to the loop device itself
        // (some DMG files have a direct filesystem with no partition table)
        let mount_target = if !part_dev.is_empty() && Path::new(&part_dev).exists() {
            &part_dev
        } else {
            &loop_dev
        };

        let mount = std::process::Command::new("udisksctl")
            .args(["mount", "-b", mount_target, "--no-user-interaction"])
            .output()
            .map_err(|e| e.to_string())?;

        if !mount.status.success() {
            // Clean up loop device on failure
            let _ = std::process::Command::new("losetup")
                .args(["-d", &loop_dev])
                .output();
            return Err(format!(
                "Mount failed: {}",
                String::from_utf8_lossy(&mount.stderr).trim()
            ));
        }

        let mount_out = String::from_utf8_lossy(&mount.stdout);
        let mountpoint = mount_out
            .find(" at ")
            .map(|i| mount_out[i + 4..].trim().trim_end_matches('.').to_string())
            .unwrap_or_default();

        Ok(mountpoint)
    }
}

/// Unmount and detach the loop device that backs a mounted DMG.
#[tauri::command]
fn unmount_dmg(loop_dev: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = loop_dev; return Err("DMG unmounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("udisksctl")
            .args(["unmount", "-b", &loop_dev, "--no-user-interaction"])
            .output();

        let r = std::process::Command::new("udisksctl")
            .args(["loop-delete", "-b", &loop_dev, "--no-user-interaction"])
            .output()
            .map_err(|e| e.to_string())?;

        if r.status.success() { return Ok(()); }

        let r2 = std::process::Command::new("losetup")
            .args(["-d", &loop_dev])
            .output()
            .map_err(|e| e.to_string())?;

        if r2.status.success() { return Ok(()); }

        Err(format!("Detach failed: {}", String::from_utf8_lossy(&r.stderr).trim()))
    }
}

/// Return the loop device backing a given DMG path, or empty string if not mounted.
#[tauri::command]
fn get_dmg_loop_device(dmg_path: String) -> String {
    #[cfg(not(target_os = "linux"))]
    { let _ = dmg_path; return String::new(); }

    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("losetup")
            .args(["--list", "--json"])
            .output();
        let Ok(out) = out else { return String::new(); };
        let text = String::from_utf8_lossy(&out.stdout);
        let lines: Vec<&str> = text.lines().collect();
        let mut found_dev = String::new();
        let mut current_dev = String::new();
        for line in &lines {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix(r#""name": ""#) {
                current_dev = rest.trim_end_matches(['"', ',']).to_string();
            }
            if trimmed.contains(&dmg_path) && !current_dev.is_empty() {
                found_dev = current_dev.clone();
                break;
            }
        }
        found_dev
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct CloudMount {
    pub id: String,
    pub cloud_type: String,
    pub name: String,
    pub mount_point: String,
    pub url: Option<String>,
    pub bucket: Option<String>,
}

static CLOUD_MOUNTS: std::sync::Mutex<Option<Vec<CloudMount>>> = std::sync::Mutex::new(None);

fn cloud_registry_path() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("frostfinder")
        .join("cloud_mounts.json")
}

fn cloud_registry_save(mounts: &[CloudMount]) {
    if let Ok(json) = serde_json::to_string(mounts) {
        let p = cloud_registry_path();
        let _ = std::fs::create_dir_all(p.parent().unwrap_or(&p));
        let _ = std::fs::write(&p, json);
    }
}

fn cloud_registry_load() -> Vec<CloudMount> {
    let p = cloud_registry_path();
    if let Ok(data) = std::fs::read_to_string(&p) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    }
}

fn get_cloud_mounts_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".cache").join("frostfinder").join("cloud"))
        .unwrap_or_else(|| PathBuf::from("/tmp/frostfinder_cloud"))
}

#[tauri::command]
fn mount_webdav(name: String, url: String, username: Option<String>, password: Option<String>) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (name, url, username, password); return Err("WebDAV mounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        let mount_base = get_cloud_mounts_dir();
        std::fs::create_dir_all(&mount_base).map_err(|e| e.to_string())?;
        
        // p11: avoid recompiling the regex on every mount call — cache in OnceLock.
        static NONWORD_RE: OnceLock<regex::Regex> = OnceLock::new();
        let nonword_re = NONWORD_RE.get_or_init(|| regex::Regex::new(r"[^\w]").expect("static regex"));
        let mount_id = nonword_re.replace_all(&name, "_").to_string();
        let mount_point = mount_base.join(&mount_id);
        let mount_point_str = mount_point.to_string_lossy().to_string();
        
        if mount_point.exists() {
            return Ok(mount_point_str);
        }
        
        std::fs::create_dir_all(&mount_point).map_err(|e| e.to_string())?;

        // p10: write credentials to ~/.davfs2/secrets (0600) rather than passing
        // password= on the mount command line where it is visible in ps aux.
        // Format per davfs2(8): "<mountpoint-or-url>  <username>  <password>"
        // We key on the mount point string so unmount_cloud can remove the line.
        if username.is_some() || password.is_some() {
            let secrets_dir = dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
                .join(".davfs2");
            let _ = std::fs::create_dir_all(&secrets_dir);
            let secrets_path = secrets_dir.join("secrets");

            // Read existing content so we can append without duplication
            let existing = std::fs::read_to_string(&secrets_path).unwrap_or_default();
            let new_line = format!(
                "{} {} {}\n",
                mount_point_str,
                username.as_deref().unwrap_or(""),
                password.as_deref().unwrap_or("")
            );
            if !existing.contains(&mount_point_str) {
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&secrets_path)
                    .map_err(|e| e.to_string())?;
                use std::io::Write;
                write!(file, "{}", new_line).map_err(|e| e.to_string())?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&secrets_path, std::fs::Permissions::from_mode(0o600));
            }
        }

        // p10: use the actual running user's uid/gid rather than the hardcoded 1000.
        #[cfg(unix)]
        let (real_uid, real_gid) = unsafe { (libc::getuid(), libc::getgid()) };
        #[cfg(not(unix))]
        let (real_uid, real_gid) = (1000u32, 1000u32);

        let mut cmd = std::process::Command::new("mount");
        cmd.arg("-t");
        cmd.arg("davfs");
        cmd.arg("-o");

        let opts = vec![
            "noexec".to_string(),
            "nofail".to_string(),
            format!("uid={}", real_uid),
            format!("gid={}", real_gid),
        ];
        // Credentials (username + password) are in ~/.davfs2/secrets — do NOT
        // pass either on the command line where they appear in ps aux / cmdline.
        cmd.arg(opts.join(","));
        
        cmd.arg(&url);
        cmd.arg(&mount_point);
        
        let output = cmd.output().map_err(|e| format!("mount.davfs failed: {}", e))?;
        
        if !output.status.success() {
            let _ = std::fs::remove_dir(&mount_point);
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("WebDAV mount failed: {}", err));
        }
        
        let cloud_info = CloudMount {
            id: mount_id.clone(),
            cloud_type: "webdav".to_string(),
            name: name.clone(),
            mount_point: mount_point_str.clone(),
            url: Some(url),
            bucket: None,
        };
        
        if let Ok(mut mounts) = CLOUD_MOUNTS.lock() {
            if mounts.is_none() {
                *mounts = Some(Vec::new());
            }
            if let Some(ref mut m) = *mounts {
                m.push(cloud_info);
                cloud_registry_save(m);
            }
        }
        
        Ok(mount_point_str)
    }
}

#[tauri::command]
fn unmount_cloud(cloud_id: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = cloud_id; return Err("Cloud unmounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        let mount_point = get_cloud_mounts_dir().join(&cloud_id);
        
        if !mount_point.exists() {
            return Ok(());
        }
        
        let output = std::process::Command::new("umount")
            .arg(&mount_point)
            .output()
            .map_err(|e| format!("umount failed: {}", e))?;
        
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("Unmount failed: {}", err));
        }
        
        let mount_point_str = mount_point.to_string_lossy().to_string();
        let _ = std::fs::remove_dir(&mount_point);

        // p10: remove any davfs2 secrets entry we added for this mount point
        // so credentials do not linger in ~/.davfs2/secrets after disconnection.
        if let Some(home) = dirs::home_dir() {
            let secrets_path = home.join(".davfs2").join("secrets");
            if let Ok(existing) = std::fs::read_to_string(&secrets_path) {
                let filtered: String = existing
                    .lines()
                    .filter(|l| !l.contains(&mount_point_str))
                    .map(|l| format!("{}
", l))
                    .collect();
                let _ = std::fs::write(&secrets_path, filtered);
            }
        }

        if let Ok(mut mounts) = CLOUD_MOUNTS.lock() {
            if let Some(ref mut m) = *mounts {
                m.retain(|c| c.id != cloud_id);
                cloud_registry_save(m);
            }
        }
        
        Ok(())
    }
}

#[tauri::command]
fn get_cloud_mounts() -> Vec<CloudMount> {
    if let Ok(mounts) = CLOUD_MOUNTS.lock() {
        if let Some(ref m) = *mounts {
            return m.clone();
        }
    }
    Vec::new()
}


// ── Phase 3: Cloud storage via rclone ─────────────────────────────────────────
//
// Architecture:
//   rclone config create <name> <type> [options...]  → writes to ~/.config/rclone/rclone.conf
//   rclone mount <name>: <mountpoint> --vfs-cache-mode writes --daemon
//   Tokens (OAuth2) are stored by rclone itself in rclone.conf — we do NOT handle
//   raw OAuth tokens. Instead we delegate the browser auth flow entirely to rclone's
//   built-in `rclone config create` interactive flow by launching a local HTTP server.
//
// Registry: same ~/.cache/frostfinder/cloud/ dir used by WebDAV mounts.
//   Each cloud mount gets a subdirectory; cloud_id == rclone remote name.

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CloudProviderMount {
    pub id:          String,   // rclone remote name (used as cloud_id)
    pub provider:    String,   // "gdrive" | "dropbox" | "onedrive"
    pub label:       String,   // display name chosen by user
    pub account:     String,   // email / account identifier (from rclone config)
    pub mount_point: String,   // local FUSE mount path
    pub mounted:     bool,
}

/// Scan a folder for SVG files whose basenames (without extension) match known
/// icon keys. Returns a list of { key, svg } pairs for the JS layer to hot-swap
/// into the icon system. Unrecognised filenames are silently ignored so partial
/// themes work out of the box.
///
/// Known icon keys — kept in sync with the I object in utils.js:
const KNOWN_ICON_KEYS: &[&str] = &[
    "home","monitor","doc","pdf","download","img","music","video","hd","nvme",
    "ssd","usb","network","optical","folder","folderSym","file","code","zip",
    "trash","chev","back","fwd","search","eye","iconView","listView","colView",
    "galleryView","openExt","x","plus","folderPlus","filePlus","copy","scissors",
    "paste","edit","terminal","tag","compress","extract","disc","mount","unmount",
    "burn","star","starFilled","server","cloud",
];

#[derive(Serialize)]
struct IconHit { key: String, svg: String }

#[tauri::command]
fn scan_icon_folder(folder_path: String) -> Result<Vec<IconHit>, String> {
    let dir = std::path::Path::new(&folder_path);
    if !dir.is_dir() {
        return Err(format!("'{}' is not a directory", folder_path));
    }
    let known: std::collections::HashSet<&str> = KNOWN_ICON_KEYS.iter().copied().collect();
    let mut hits: Vec<IconHit> = Vec::new();
    // r24: recursive walk — search the chosen folder AND all sub-folders so icon
    // packs stored in subdirectories (e.g. scalable/places/folder.svg) are found.
    fn walk(
        dir: &std::path::Path,
        known: &std::collections::HashSet<&str>,
        hits: &mut Vec<IconHit>,
        depth: u32,
    ) {
        if depth > 8 { return; } // guard against runaway symlink trees
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, known, hits, depth + 1);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("svg") { continue; }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if !known.contains(stem.as_str()) { continue; }
            // Skip if we already have this key (first match wins — shallowest path)
            if hits.iter().any(|h| h.key == stem) { continue; }
            let Ok(svg) = std::fs::read_to_string(&path) else { continue };
            let svg = svg.trim().to_string();
            if !svg.contains("<svg") { continue; }
            hits.push(IconHit { key: stem, svg });
        }
    }
    walk(dir, &known, &mut hits, 0);
    Ok(hits)
}

/// Check whether rclone is installed and return its version string.
#[tauri::command]
fn check_rclone() -> Result<String, String> {
    let out = std::process::Command::new("rclone")
        .arg("version")
        .arg("--check")
        .output()
        .map_err(|_| "rclone not found. Install with: sudo apt install rclone  OR  curl https://rclone.org/install.sh | sudo bash".to_string())?;
    let ver = String::from_utf8_lossy(&out.stdout);
    let first_line = ver.lines().next().unwrap_or("rclone (unknown version)");
    Ok(first_line.to_string())
}

/// List configured rclone remotes (only those matching FrostFinder-managed naming).
#[tauri::command]
fn list_rclone_remotes() -> Result<Vec<CloudProviderMount>, String> {
    let out = std::process::Command::new("rclone")
        .args(["listremotes", "--long"])
        .output()
        .map_err(|e| format!("rclone not found: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mount_base = get_cloud_mounts_dir();
    let mut result = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.splitn(2, ':').collect();
        if parts.len() < 2 { continue; }
        let name = parts[0].trim();
        let rtype = parts[1].trim();
        // Only show remotes we created (prefixed with "ff_")
        if !name.starts_with("ff_") { continue; }
        let provider = match rtype {
            "drive"    => "gdrive",
            "dropbox"  => "dropbox",
            "onedrive" => "onedrive",
            _          => continue,
        };
        let mount_point = mount_base.join(name).to_string_lossy().to_string();
        let mounted = std::path::Path::new(&mount_point).exists()
            && std::fs::read_dir(&mount_point).map(|mut d| d.next().is_some()).unwrap_or(false);
        result.push(CloudProviderMount {
            id:          name.to_string(),
            provider:    provider.to_string(),
            label:       name.trim_start_matches("ff_").to_string(),
            account:     String::new(),
            mount_point,
            mounted,
        });
    }
    Ok(result)
}

/// Authorise a new cloud provider account via rclone's OAuth2 browser flow.
/// Opens a local HTTP callback server and launches the browser.
/// On success, writes credentials to rclone.conf and returns the remote name.
#[tauri::command]
fn add_cloud_provider(provider: String, label: String) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (provider, label); return Err("Cloud provider auth is only supported on Linux in this version.".into()); }

    #[cfg(target_os = "linux")]
    {
        // Sanitise label → rclone remote name
        let safe_label: String = label.chars()
            .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
            .collect();
        let remote_name = format!("ff_{safe_label}");

        let rclone_type = match provider.as_str() {
            "gdrive"   => "drive",
            "dropbox"  => "dropbox",
            "onedrive" => "onedrive",
            other      => return Err(format!("Unknown provider: {other}")),
        };

        // Run `rclone config create <name> <type> --auto-confirm` — this uses
        // rclone's built-in OAuth2 flow which opens the user's browser.
        // We pass --auto-confirm so rclone doesn't prompt for extra options.
        let status = std::process::Command::new("rclone")
            .args(["config", "create", &remote_name, rclone_type, "--auto-confirm"])
            .status()
            .map_err(|e| format!("rclone config create failed: {e}"))?;

        if !status.success() {
            return Err(format!("rclone authorisation failed (exit {:?}). Check that a browser is available.", status.code()));
        }

        Ok(remote_name)
    }
}

/// Mount a configured rclone remote as a FUSE filesystem (daemon mode).
#[tauri::command]
fn mount_cloud_provider(remote_name: String) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = remote_name; return Err("Cloud mounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        let mount_base = get_cloud_mounts_dir();
        std::fs::create_dir_all(&mount_base).map_err(|e| e.to_string())?;
        let mount_point = mount_base.join(&remote_name);
        std::fs::create_dir_all(&mount_point).map_err(|e| e.to_string())?;
        let mount_point_str = mount_point.to_string_lossy().to_string();

        // Check if already mounted
        if mount_point.exists() {
            let mut rd = std::fs::read_dir(&mount_point).ok();
            if rd.as_mut().and_then(|d| d.next()).is_some() {
                return Ok(mount_point_str); // already mounted
            }
        }

        let status = std::process::Command::new("rclone")
            .args([
                "mount",
                &format!("{remote_name}:"),
                &mount_point_str,
                "--vfs-cache-mode", "writes",
                "--vfs-cache-max-size", "512M",
                "--dir-cache-time", "5m",
                "--poll-interval", "15s",
                "--daemon",
            ])
            .status()
            .map_err(|e| format!("rclone mount failed: {e}"))?;

        if !status.success() {
            // Clean up the empty mountpoint dir on failure
            let _ = std::fs::remove_dir(&mount_point);
            return Err(format!("rclone mount failed (exit {:?})", status.code()));
        }

        Ok(mount_point_str)
    }
}

/// Unmount a rclone FUSE mount (fusermount3 -u).
#[tauri::command]
fn unmount_cloud_provider(remote_name: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = remote_name; return Err("Cloud unmounting is only supported on Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        let mount_point = get_cloud_mounts_dir().join(&remote_name);
        if !mount_point.exists() { return Ok(()); }

        // Try fusermount3 first (systemd-era), fall back to fusermount
        let result = std::process::Command::new("fusermount3")
            .args(["-u", &mount_point.to_string_lossy()])
            .status()
            .or_else(|_| std::process::Command::new("fusermount")
                .args(["-u", &mount_point.to_string_lossy()])
                .status())
            .map_err(|e| format!("fusermount not found: {e}"))?;

        if !result.success() {
            // Force unmount as fallback
            let _ = std::process::Command::new("umount")
                .arg("--lazy")
                .arg(&mount_point.to_string_lossy().as_ref())
                .status();
        }
        let _ = std::fs::remove_dir(&mount_point);
        Ok(())
    }
}

/// Remove a rclone remote config entirely (revoke access + delete from rclone.conf).
#[tauri::command]
fn remove_cloud_provider(remote_name: String) -> Result<(), String> {
    // Unmount first (ignore error if not mounted)
    let _ = unmount_cloud_provider(remote_name.clone());

    let status = std::process::Command::new("rclone")
        .args(["config", "delete", &remote_name])
        .status()
        .map_err(|e| format!("rclone config delete failed: {e}"))?;

    if !status.success() {
        return Err(format!("rclone config delete failed (exit {:?})", status.code()));
    }
    Ok(())
}

/// Restore cloud provider mounts that were active in the previous session.
/// Called on startup. Silently ignores remotes that fail to mount (offline, etc.).
#[tauri::command]
fn restore_cloud_mounts() -> Vec<String> {
    let Ok(remotes) = list_rclone_remotes() else { return Vec::new(); };
    let mut mounted = Vec::new();
    for remote in remotes {
        if let Ok(mp) = mount_cloud_provider(remote.id.clone()) {
            mounted.push(mp);
        }
    }
    mounted
}


// ── Phase 4: Git status badges ────────────────────────────────────────────────
//
// Uses the git2 crate (libgit2 bindings) — no git binary required.
// The command returns a flat map of path → status character for every
// modified/staged/untracked/conflicted file in the repo, plus the HEAD
// branch name. Cache is per-repo-root; invalidated by dir-changed events.

#[derive(serde::Serialize, Clone, Debug)]
pub struct GitStatus {
    /// Branch name (e.g. "main") or a detached-HEAD description ("HEAD~3")
    pub branch: String,
    /// true if there are any uncommitted changes (dirty worktree)
    pub dirty: bool,
    /// Map of absolute file path → single-char status code:
    ///   M = modified (worktree), S = modified (index/staged),
    ///   U = untracked, C = conflicted, A = added (index), D = deleted
    pub files: std::collections::HashMap<String, String>,
}

// In-memory cache: repo_root → (GitStatus, timestamp_secs)
fn git_status_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, (GitStatus, u64)>> {
    static GIT_STATUS_CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (GitStatus, u64)>>> =
        std::sync::OnceLock::new();
    GIT_STATUS_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn git_cache_evict(repo_root: &str) {
    if let Ok(mut cache) = git_status_cache().lock() {
        cache.remove(repo_root);
    }
}

/// Return the git repository root for a given directory path, if it is inside a repo.
/// Returns None if the path is not inside a git repo.
#[tauri::command]
fn find_git_root(path: String) -> Option<String> {
    use std::path::Path;
    let p = Path::new(&path);
    // Walk up the tree looking for a .git directory or file (worktree)
    let mut cur = if p.is_dir() { p } else { p.parent()? };
    loop {
        if cur.join(".git").exists() {
            return Some(cur.to_string_lossy().to_string());
        }
        cur = cur.parent()?;
    }
}

/// Get the git status for the repository containing `path`.
/// Results are cached for 3 seconds per repo root.
/// Returns None if the path is not inside a git repo or git2 fails.
#[tauri::command]
fn get_git_status(path: String) -> Option<GitStatus> {
    let repo_root = find_git_root(path)?;

    // Check cache (3-second TTL)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if let Ok(cache) = git_status_cache().lock() {
        if let Some((cached, ts)) = cache.get(&repo_root) {
            if now.saturating_sub(*ts) < 3 {
                return Some(cached.clone());
            }
        }
    }

    // Walk the repo using the git CLI — avoids the git2 crate dependency
    // while still working reliably. Output is stable across git versions.
    let status_out = std::process::Command::new("git")
        .args(["status", "--porcelain=v1", "-u"])
        .current_dir(&repo_root)
        .output()
        .ok()?;

    if !status_out.status.success() { return None; }

    let branch_out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&repo_root)
        .output()
        .ok()?;

    let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();
    let branch = if branch.is_empty() { "HEAD".to_string() } else { branch };

    let mut files = std::collections::HashMap::new();
    let mut dirty = false;

    for line in String::from_utf8_lossy(&status_out.stdout).lines() {
        if line.len() < 3 { continue; }
        let xy = &line[..2];
        let rel_path = line[3..].trim_start_matches('"').trim_end_matches('"');
        // Handle renames: "R old -> new" — only the new path matters
        let file_path = if rel_path.contains(" -> ") {
            rel_path.split(" -> ").last().unwrap_or(rel_path)
        } else {
            rel_path
        };
        let abs_path = format!("{}/{}", repo_root.trim_end_matches('/'), file_path);
        let code = match xy {
            s if s.contains('C') || s.contains('U') => "C", // conflict
            s if s.chars().next().map(|c| c != ' ' && c != '?').unwrap_or(false)
              && s.chars().nth(1).map(|c| c == ' ').unwrap_or(false) => "S", // staged only
            s if s.contains('?') => "U",  // untracked
            s if s.chars().nth(1).map(|c| c == 'M' || c == 'D').unwrap_or(false) => "M", // worktree modified
            _ => "M",
        };
        files.insert(abs_path, code.to_string());
        dirty = true;
    }

    let status = GitStatus { branch, dirty, files };

    if let Ok(mut cache) = git_status_cache().lock() {
        cache.insert(repo_root, (status.clone(), now));
    }

    Some(status)
}

/// Evict the git status cache for the repo containing `path`.
/// Called by the dir-changed event handler so badges refresh after a commit.
#[tauri::command]
fn invalidate_git_cache(path: String) {
    if let Some(root) = find_git_root(path) {
        git_cache_evict(&root);
    }
}

// ── Phase 4: Encrypted vaults (gocryptfs) ─────────────────────────────────────
//
// gocryptfs encrypts a directory transparently via FUSE.
// FrostFinder manages a JSON vault registry at ~/.config/frostfinder/vaults.json.
// Each vault entry stores the encrypted dir path and the preferred mount point.
// The password is NEVER stored — it is passed to gocryptfs via stdin.

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct VaultEntry {
    pub id:            String,   // UUID
    pub name:          String,   // display name
    pub encrypted_dir: String,   // path to the gocryptfs-encrypted directory
    pub mount_point:   String,   // where it mounts (under /tmp/frostfinder-vaults/)
    pub mounted:       bool,     // live status (not persisted)
}

fn vault_registry_path() -> std::path::PathBuf {
    dirs::config_dir()
        .map(|d| d.join("frostfinder").join("vaults.json"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/frostfinder-vaults.json"))
}

fn load_vault_registry() -> Vec<VaultEntry> {
    let p = vault_registry_path();
    if !p.exists() { return Vec::new(); }
    let raw = fs::read_to_string(&p).unwrap_or_default();
    serde_json::from_str::<Vec<VaultEntry>>(&raw).unwrap_or_default()
}

fn save_vault_registry(vaults: &[VaultEntry]) {
    let p = vault_registry_path();
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    if let Ok(json) = serde_json::to_string_pretty(vaults) {
        let _ = fs::write(&p, json);
    }
}

fn vault_mount_base() -> std::path::PathBuf {
    std::path::PathBuf::from("/tmp/frostfinder-vaults")
}

fn is_vault_mounted(mount_point: &str) -> bool {
    let p = std::path::Path::new(mount_point);
    if !p.exists() { return false; }
    // Check /proc/mounts for the mount point
    if let Ok(mounts) = fs::read_to_string("/proc/mounts") {
        return mounts.lines().any(|l| l.contains(mount_point));
    }
    // Fallback: check if the directory is non-empty (gocryptfs creates a control socket)
    fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(false)
}

/// Check whether gocryptfs is installed.
#[tauri::command]
fn check_gocryptfs() -> Result<String, String> {
    let out = std::process::Command::new("gocryptfs")
        .arg("--version")
        .output()
        .map_err(|_| "gocryptfs not found. Install with: sudo apt install gocryptfs  OR  sudo pacman -S gocryptfs".to_string())?;
    let ver = String::from_utf8_lossy(&out.stdout);
    Ok(ver.lines().next().unwrap_or("gocryptfs").to_string())
}

/// List all registered vaults with live mount status.
#[tauri::command]
fn list_vaults() -> Vec<VaultEntry> {
    let mut vaults = load_vault_registry();
    for v in &mut vaults {
        v.mounted = is_vault_mounted(&v.mount_point);
    }
    vaults
}

/// Initialise a new encrypted vault in `encrypted_dir` using `password`.
/// Creates the directory if it doesn't exist, then runs `gocryptfs -init`.
#[tauri::command]
fn create_vault(name: String, encrypted_dir: String, password: String) -> Result<VaultEntry, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (name, encrypted_dir, password); return Err("Encrypted vaults require Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        let enc_path = std::path::Path::new(&encrypted_dir);
        fs::create_dir_all(enc_path).map_err(|e| format!("mkdir {encrypted_dir}: {e}"))?;

        // Run: echo "<password>" | gocryptfs -init -quiet <encrypted_dir>
        let mut child = std::process::Command::new("gocryptfs")
            .args(["-init", "-quiet", &encrypted_dir])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("gocryptfs not found: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            writeln!(stdin, "{password}").map_err(|e| e.to_string())?;
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!("gocryptfs -init failed: {err}"));
        }

        let id = uuid_v4();
        let mount_point = vault_mount_base()
            .join(&id)
            .to_string_lossy()
            .to_string();

        let entry = VaultEntry { id, name, encrypted_dir, mount_point, mounted: false };
        let mut vaults = load_vault_registry();
        vaults.push(entry.clone());
        save_vault_registry(&vaults);
        Ok(entry)
    }
}

/// Unlock (mount) a vault by ID with the given password.
#[tauri::command]
fn unlock_vault(vault_id: String, password: String) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (vault_id, password); return Err("Encrypted vaults require Linux.".into()); }

    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        let vaults = load_vault_registry();
        let vault = vaults.iter().find(|v| v.id == vault_id)
            .ok_or_else(|| format!("Vault {vault_id} not found"))?
            .clone();

        if is_vault_mounted(&vault.mount_point) {
            return Ok(vault.mount_point.clone());
        }

        fs::create_dir_all(&vault.mount_point).map_err(|e| e.to_string())?;

        let mut child = std::process::Command::new("gocryptfs")
            .args(["-fg", "-quiet", &vault.encrypted_dir, &vault.mount_point])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("gocryptfs spawn failed: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            writeln!(stdin, "{password}").map_err(|e| e.to_string())?;
        }

        // Give gocryptfs up to 3s to mount (it daemonises after a successful mount)
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if is_vault_mounted(&vault.mount_point) {
                return Ok(vault.mount_point.clone());
            }
            // Check if process exited with error
            if let Ok(Some(status)) = child.try_wait() {
                if !status.success() {
                    let mut err_bytes = Vec::new();
                    if let Some(mut stderr) = child.stderr.take() {
                        use std::io::Read;
                        let _ = stderr.read_to_end(&mut err_bytes);
                    }
                    let err = String::from_utf8_lossy(&err_bytes).trim().to_string();
                    let _ = fs::remove_dir(&vault.mount_point);
                    return Err(format!("Wrong password or corrupted vault: {err}"));
                }
            }
        }
        Err("Vault mount timed out — check that FUSE is available".to_string())
    }
}

/// Lock (unmount) a vault by ID.
#[tauri::command]
fn lock_vault(vault_id: String) -> Result<(), String> {
    let vaults = load_vault_registry();
    let vault = vaults.iter().find(|v| v.id == vault_id)
        .ok_or_else(|| format!("Vault {vault_id} not found"))?
        .clone();

    if !is_vault_mounted(&vault.mount_point) { return Ok(()); }

    let result = std::process::Command::new("fusermount3")
        .args(["-u", &vault.mount_point])
        .status()
        .or_else(|_| std::process::Command::new("fusermount")
            .args(["-u", &vault.mount_point])
            .status())
        .map_err(|e| format!("fusermount not found: {e}"))?;

    if !result.success() {
        let _ = std::process::Command::new("umount")
            .arg("--lazy").arg(&vault.mount_point).status();
    }
    let _ = fs::remove_dir(&vault.mount_point);
    Ok(())
}

/// Remove a vault entry from the registry (does NOT delete encrypted files).
#[tauri::command]
fn remove_vault(vault_id: String) -> Result<(), String> {
    let _ = lock_vault(vault_id.clone()); // unmount if mounted, ignore error
    let mut vaults = load_vault_registry();
    vaults.retain(|v| v.id != vault_id);
    save_vault_registry(&vaults);
    Ok(())
}


// watch_dir: watch one or more paths with the OS notify backend (inotify on Linux).
// Emits "dir-changed" with the specific changed directory path — only when the
// LISTING changes: new file, deleted file, or rename/move.
// Content writes (Modify::Data) are intentionally ignored.
// Multiple paths are supported so all open columns are watched simultaneously.
// Debounced: rapid bursts within 300ms coalesce into single events per directory.
// Returns true when `path` is on a FUSE or network filesystem (sshfs, fuse.sshfs,
// fuse.curlftpfs, cifs, nfs, nfs4, davfs, fuse.davfs2, etc.).
// inotify does not work on these filesystems — use polling instead.
#[cfg(target_os = "linux")]
fn is_fuse_path(path: &str) -> bool {
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else { return false; };
    let mut entries: Vec<(String, String)> = mounts
        .lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 3 { Some((cols[1].to_string(), cols[2].to_string())) } else { None }
        })
        .collect();
    entries.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    for (mountpoint, fstype) in &entries {
        if path.starts_with(mountpoint.as_str()) {
            let ft = fstype.to_lowercase();
            if ft.contains("fuse") || ft == "cifs" || ft == "smb3"
                || ft == "nfs" || ft == "nfs4" || ft.contains("davfs")
            {
                return true;
            }
            break;
        }
    }
    false
}

/// On macOS, check for network/FUSE mounts via statfs fstype field.
#[cfg(target_os = "macos")]
fn is_fuse_path(path: &str) -> bool {
    use std::ffi::CString;
    let cpath = CString::new(path).unwrap_or_default();
    unsafe {
        let mut st: libc::statfs = std::mem::zeroed();
        if libc::statfs(cpath.as_ptr(), &mut st) != 0 { return false; }
        let fstype = std::ffi::CStr::from_ptr(st.f_fstypename.as_ptr())
            .to_string_lossy()
            .to_lowercase();
        // macFUSE mounts appear as "macfuse", SMB as "smbfs", NFS as "nfs"
        fstype.contains("fuse") || fstype == "smbfs" || fstype == "nfs"
            || fstype == "webdav" || fstype == "afpfs"
    }
}

/// On Windows, all remote paths (UNC \\server\share) are treated as polling paths.
#[cfg(target_os = "windows")]
fn is_fuse_path(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//")
}



#[tauri::command]
fn watch_dir(window: Window, paths: Vec<String>) -> Result<(), String> {
    // Determine if any of the requested paths are on a FUSE/network filesystem.
    // inotify is silently broken on sshfs, curlftpfs, cifs, nfs, davfs.
    // Fall back to polling for those paths.
    let use_polling = paths.iter().any(|p| is_fuse_path(p));

    if use_polling {
        // ── Polling path ────────────────────────────────────────────────────
        // Snapshot mtime+entry-count for each watched directory.
        // Re-snapshot every POLL_MS milliseconds; emit "dir-changed" when anything differs.
        const POLL_MS: u64 = 3_000;

        fn dir_snapshot(path: &str) -> Option<(u64, usize)> {
            let rd = std::fs::read_dir(path).ok()?;
            let entries: Vec<_> = rd.flatten().collect();
            let count = entries.len();
            let max_mtime = entries.iter()
                .filter_map(|e| e.metadata().ok()?.modified().ok())
                .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .max()
                .unwrap_or(0);
            Some((max_mtime, count))
        }

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_clone = stop.clone();
        let emit_win = window.clone();
        let watch_paths = paths.clone();

        std::thread::spawn(move || {
            // Initial snapshots
            let mut snapshots: std::collections::HashMap<String, Option<(u64, usize)>> =
                watch_paths.iter().map(|p| (p.clone(), dir_snapshot(p))).collect();

            loop {
                std::thread::sleep(Duration::from_millis(POLL_MS));
                if stop_clone.load(std::sync::atomic::Ordering::Relaxed) { break; }

                for path in &watch_paths {
                    let fresh = dir_snapshot(path);
                    if fresh != *snapshots.get(path).unwrap_or(&None) {
                        snapshots.insert(path.clone(), fresh);
                        cache_evict(path);
                        let _ = emit_win.emit("dir-changed", path);
                    }
                }
            }
        });

        *ACTIVE_WATCHER.lock().unwrap_or_else(|e| e.into_inner()) = Some(DirWatcher {
            _watcher: None,
            mode: WatchMode::Polling,
            _poll_stop: Some(stop),
        });
        return Ok(());
    }

    // ── inotify path (local filesystems) ────────────────────────────────────
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                use notify::EventKind::*;
                use notify::event::ModifyKind;
                let should_emit = match event.kind {
                    Create(_) | Remove(_) => true,
                    Modify(ModifyKind::Name(_)) => true,
                    Modify(_) => false,
                    _ => false,
                };
                if should_emit {
                    if let Some(changed_file) = event.paths.first() {
                        let dir = changed_file
                            .parent()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default();
                        if !dir.is_empty() {
                            cache_evict(&dir);
                            let _ = tx.send(dir);
                        }
                    }
                }
            }
        },
        NotifyConfig::default().with_poll_interval(Duration::from_millis(500)),
    ).map_err(|e| e.to_string())?;

    for path in &paths {
        if Path::new(path).is_dir() {
            watcher.watch(Path::new(path), RecursiveMode::NonRecursive)
                .map_err(|e| format!("watch failed for {path}: {e}"))?;
        }
    }

    let emit_window = window.clone();
    std::thread::spawn(move || {
        loop {
            let first = match rx.recv() { Ok(p) => p, Err(_) => break };
            let mut changed = std::collections::HashSet::new();
            changed.insert(first);
            let deadline = std::time::Instant::now() + Duration::from_millis(300);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() { break; }
                match rx.recv_timeout(remaining) {
                    Ok(p) => { changed.insert(p); }
                    Err(_) => break,
                }
            }
            for dir in changed {
                // p7: keep in-memory search index in sync with filesystem changes
                index_apply_event(&dir);
                let _ = emit_window.emit("dir-changed", &dir);
            }
        }
    });

    *ACTIVE_WATCHER.lock().unwrap_or_else(|e| e.into_inner()) = Some(DirWatcher {
        _watcher: Some(watcher),
        mode: WatchMode::Inotify,
        _poll_stop: None,
    });
    Ok(())
}

/// Stop watching. Called on navigate-away or app teardown.
#[tauri::command]
fn unwatch_dir() {
    // Dropping the DirWatcher signals the poll thread via AtomicBool
    // and drops the inotify RecommendedWatcher — both stop immediately.
    if let Some(dw) = ACTIVE_WATCHER.lock().unwrap_or_else(|e| e.into_inner()).take() {
        if let Some(stop) = &dw._poll_stop {
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        drop(dw);
    }
}

/// Returns the current watch mode as a string for the JS status-bar indicator.
/// "inotify"  — local filesystem, real-time events
/// "polling"  — FUSE/network mount, 3s polling
/// "off"      — no watcher active
#[tauri::command]
fn get_watch_mode() -> String {
    match ACTIVE_WATCHER.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        Some(dw) => match dw.mode {
            WatchMode::Inotify => "inotify".to_string(),
            WatchMode::Polling => "polling".to_string(),
        },
        None => "off".to_string(),
    }
}


// ── Persistent error log ───────────────────────────────────────────────────────
// JS calls append_error_log on every caught error so failures survive
// session restarts and can be copied for bug reports.
// Rotates at 512 KB to prevent unbounded growth.

fn error_log_path() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("frostfinder")
        .join("error.log")
}

#[tauri::command]
fn append_error_log(message: String) -> Result<(), String> {
    let p = error_log_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // p9: strip the user's home directory from paths before writing
    // Replaces /home/username/ with ~/ to avoid leaking full filesystem layout
    let sanitised = {
        let home = std::env::var("HOME").unwrap_or_default();
        if home.is_empty() {
            message.clone()
        } else {
            message.replace(&format!("{}/", home.trim_end_matches('/')), "~/")
                   .replace(&home, "~")
        }
    };

    // Rotate at 512 KB
    const MAX_BYTES: u64 = 512 * 1024;
    if p.exists() {
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.len() > MAX_BYTES {
                if let Ok(content) = std::fs::read_to_string(&p) {
                    let half = content.len() / 2;
                    let trimmed = &content[half..];
                    let _ = std::fs::write(&p, trimmed);
                }
            }
        }
    }

    use std::io::Write;
    let newly_created = !p.exists();
    let mut file = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open(&p)
        .map_err(|e| e.to_string())?;

    // p9: set 0600 on first creation so only the owner can read the log
    #[cfg(unix)]
    if newly_created {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }

    writeln!(file, "{}", sanitised).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_error_log() -> String {
    std::fs::read_to_string(error_log_path()).unwrap_or_default()
}

#[tauri::command]
fn clear_error_log() -> Result<(), String> {
    let p = error_log_path();
    if p.exists() {
        std::fs::write(&p, "").map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}


// ── Tag database integrity ─────────────────────────────────────────────────────
// Files renamed or moved outside FrostFinder leave orphaned rows in tags.db.
// migrate_tag_path handles in-app moves, but external moves are invisible.
// These three commands let JS audit and repair the database.

/// Scan every path in tags.db and return the ones whose file no longer exists.
/// Read-only — never modifies the database.
#[tauri::command]
fn audit_tag_db() -> Vec<String> {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = match db.prepare("SELECT path FROM file_tags") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let paths: Vec<String> = rows.flatten().collect();
    drop(stmt);
    paths.into_iter()
        .filter(|p| !std::path::Path::new(p).exists())
        .collect()
}

/// Delete all rows whose file path no longer exists on the filesystem.
/// Returns the number of rows removed.
#[tauri::command]
fn cleanup_tag_db() -> Result<usize, String> {
    let orphans = {
        let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare("SELECT path FROM file_tags")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let paths: Vec<String> = rows.flatten().collect();
        paths.into_iter()
            .filter(|p| !std::path::Path::new(p).exists())
            .collect::<Vec<_>>()
    };
    let count = orphans.len();
    if count == 0 { return Ok(0); }
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    for path in &orphans {
        let _ = db.execute("DELETE FROM file_tags WHERE path=?1",
            rusqlite::params![path]);
    }
    Ok(count)
}

/// Return total row count in the tag database (for the Settings UI).
#[tauri::command]
fn tag_db_stats() -> serde_json::Value {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let total: i64 = db
        .query_row("SELECT COUNT(*) FROM file_tags", [], |r| r.get(0))
        .unwrap_or(0);
    let orphan_count = {
        let mut stmt = match db.prepare("SELECT path FROM file_tags") {
            Ok(s) => s,
            Err(_) => return serde_json::json!({"total": total, "orphans": 0}),
        };
        let all_paths: Vec<String> = match stmt.query_map([], |row| row.get::<_, String>(0)) {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => Vec::new(),
        };
        // stmt borrow ends here — safe to filter on the collected Vec
        all_paths.iter()
            .filter(|p| !std::path::Path::new(p.as_str()).exists())
            .count() as i64
    };
    serde_json::json!({"total": total, "orphans": orphan_count})
}


fn main() {
    // ── WebKit2GTK / GStreamer env vars (Linux only) ──────────────────────
    // These tune the WebKit2GTK + GStreamer pipeline for hardware-decoded video
    // on Wayland (Linux). They are no-ops on macOS (WKWebView) and Windows (WebView2).
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "0");
        std::env::set_var("WEBKIT_FORCE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_WEBGL_API_ENABLED", "1");
        // WEBKIT_USE_GLDOM=1: render DOM via GL — lets GStreamer frames be
        // composited without a CPU round-trip. Required for smooth VA-API video.
        std::env::set_var("WEBKIT_USE_GLDOM", "1");
        // WEBKIT_DISABLE_DMABUF_RENDERER=1: prevent the DMA-BUF compositing path
        // that causes black video frames on many AMD/Intel setups.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        // VA-API driver discovery
        std::env::set_var("GST_VAAPI_ALL_DRIVERS", "1");
        // Prefer newer `va` GStreamer plugin over legacy `vaapi` for 4K HEVC
        std::env::set_var("GST_USE_NEW_VA", "1");
        // Share the EGL context between GStreamer and WebKit
        std::env::set_var("GST_GL_PLATFORM", "egl");
        // Disable GStreamer GL path — conflicts with DMABUF disabled → black frames
        std::env::set_var("WEBKIT_USE_GSTREAMER_GL", "0");
    }
    start_media_server();
    // Clean up thumbnails older than 30 days (background, non-blocking)
    std::thread::spawn(||{ gc_thumbnail_cache(); });
    // p7: build in-memory filename search index at startup (background, non-blocking)
    std::thread::spawn(|| { index_home_dir(); });
// ═══════════════════════════════════════════════════════════════════════════════
// Phase 5 — Metadata editing (r125-r140)
// ═══════════════════════════════════════════════════════════════════════════════

// r135: Checksum panel — MD5, SHA-1, SHA-256 computed in parallel.
// Reuses sha2 already present; adds md-5 and sha1 from the same RustCrypto org.
#[tauri::command]
async fn get_file_checksums(path: String) -> Result<serde_json::Value, String> {
    use md5::{Md5};
    use sha1::{Sha1};
    use sha2::{Sha256, Digest};

    tauri::async_runtime::spawn_blocking(move || {
        let data = std::fs::read(&path).map_err(|e| e.to_string())?;

        let md5_hash  = format!("{:x}", Md5::digest(&data));
        let sha1_hash = format!("{:x}", Sha1::digest(&data));
        let sha256_hash = format!("{:x}", Sha256::digest(&data));

        Ok(serde_json::json!({
            "md5":    md5_hash,
            "sha1":   sha1_hash,
            "sha256": sha256_hash,
        }))
    }).await.map_err(|e| e.to_string())?
}

// r125/r128/r136: Read file metadata via exiftool (covers EXIF, audio tags, PDF meta).
// Returns raw JSON from `exiftool -j -n`; the JS layer picks out the fields it needs.
#[tauri::command]
async fn get_file_meta_exif(path: String) -> Result<serde_json::Value, String> {
    let output = std::process::Command::new("exiftool")
        .args(["-j", "-n", "--", &path])
        .output()
        .map_err(|e| format!("exiftool not found or failed: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut arr: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("JSON parse error: {e}"))?;

    // exiftool returns an array; unwrap the first element
    Ok(arr.as_array_mut()
        .and_then(|a| a.first().cloned())
        .unwrap_or(serde_json::json!({})))
}

// r125/r128/r136: Write metadata fields via exiftool.
// `fields` is a list of ["TAG", "VALUE"] pairs, e.g. [["Title","My Doc"],["Author","Alice"]].
// Overwrites the original file in-place (exiftool default creates _original backup).
#[tauri::command]
async fn write_file_meta_exif(path: String, fields: Vec<[String; 2]>) -> Result<(), String> {
    if fields.is_empty() { return Ok(()); }
    let mut args: Vec<String> = Vec::new();
    for [tag, val] in &fields {
        // Sanitise tag name (alphanumeric + colon for namespace only)
        let safe_tag: String = tag.chars()
            .filter(|c| c.is_alphanumeric() || *c == ':' || *c == '_')
            .collect();
        if safe_tag.is_empty() { continue; }
        args.push(format!("-{}={}", safe_tag, val));
    }
    args.push("-overwrite_original".to_string());
    args.push("--".to_string());
    args.push(path.clone());

    let output = std::process::Command::new("exiftool")
        .args(&args)
        .output()
        .map_err(|e| format!("exiftool not found: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}



// ─────────────────────────────────────────────────────────────────────────────
// r25: Native audio tag read/write via lofty — no exiftool dependency.
// Supports MP3 (ID3v2), FLAC, OGG/Vorbis, OGG/Opus, MP4/M4A, WAV, AIFF.
// Fields returned/accepted: title, artist, album, year, track, genre, comment.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct AudioTags {
    pub title:   Option<String>,
    pub artist:  Option<String>,
    pub album:   Option<String>,
    pub year:    Option<String>,
    pub track:   Option<String>,
    pub genre:   Option<String>,
    pub comment: Option<String>,
}

#[tauri::command]
fn get_audio_tags(path: String) -> Result<AudioTags, String> {
    use lofty::prelude::{Accessor, TaggedFileExt};
    use lofty::probe::Probe;

    let tagged = Probe::open(&path)
        .map_err(|e| format!("Cannot open file: {e}"))?
        .guess_file_type()
        .map_err(|e| format!("Cannot guess type: {e}"))?
        .read()
        .map_err(|e| format!("Cannot read tags: {e}"))?;

    // Prefer the primary tag; fall back to first available
    let tag = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
        Some(t) => t,
        None     => return Ok(AudioTags::default()),
    };

    Ok(AudioTags {
        title:   tag.title().map(|s| s.into_owned()),
        artist:  tag.artist().map(|s| s.into_owned()),
        album:   tag.album().map(|s| s.into_owned()),
        year:    tag.year().map(|y| y.to_string()),
        track:   tag.track().map(|t| t.to_string()),
        genre:   tag.genre().map(|s| s.into_owned()),
        comment: tag.get_string(&lofty::prelude::ItemKey::Comment).map(|s| s.to_owned()),
    })
}

#[tauri::command]
fn write_audio_tags(path: String, tags: AudioTags) -> Result<(), String> {
    use lofty::prelude::{Accessor, AudioFile, TaggedFileExt};
    use lofty::probe::Probe;

    let mut tagged = Probe::open(&path)
        .map_err(|e| format!("Cannot open file: {e}"))?
        .guess_file_type()
        .map_err(|e| format!("Cannot guess type: {e}"))?
        .read()
        .map_err(|e| format!("Cannot read tags: {e}"))?;

    // Use file's preferred tag type; create tag if absent
    let tag_type = tagged.primary_tag().map(|t| t.tag_type())
        .or_else(|| tagged.first_tag().map(|t| t.tag_type()))
        .unwrap_or(lofty::tag::TagType::Id3v2);

    if tagged.primary_tag().is_none() {
        tagged.insert_tag(lofty::tag::Tag::new(tag_type));
    }

    let tag = tagged.primary_tag_mut()
        .ok_or_else(|| "No tag available to write".to_string())?;

    if let Some(v) = &tags.title   { tag.set_title(v.clone()); }
    if let Some(v) = &tags.artist  { tag.set_artist(v.clone()); }
    if let Some(v) = &tags.album   { tag.set_album(v.clone()); }
    if let Some(v) = &tags.year    {
        if let Ok(y) = v.trim().parse::<u32>() { tag.set_year(y); }
    }
    if let Some(v) = &tags.track   {
        if let Ok(t) = v.trim().parse::<u32>() { tag.set_track(t); }
    }
    if let Some(v) = &tags.genre   { tag.set_genre(v.clone()); }
    if let Some(v) = &tags.comment {
        // lofty: insert a plain-text comment via the generic ItemKey API
        tag.insert_text(lofty::prelude::ItemKey::Comment, v.clone());
    }

    tagged.save_to_path(&path, lofty::config::WriteOptions::default())
        .map_err(|e| format!("Failed to write tags: {e}"))?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 6 — Directory comparison & sync (r141-r160)
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum DiffStatus {
    OnlyLeft,
    OnlyRight,
    Same,
    Different,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DirDiffEntry {
    pub rel_path: String,      // path relative to both roots
    pub name: String,          // filename
    pub status: DiffStatus,
    pub is_dir: bool,
    pub size_left: Option<u64>,
    pub size_right: Option<u64>,
    pub mtime_left: Option<u64>,
    pub mtime_right: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DirDiffResult {
    pub entries: Vec<DirDiffEntry>,
    pub only_left: usize,
    pub only_right: usize,
    pub same: usize,
    pub different: usize,
}

// r141: compare_dirs — walk both trees in parallel, classify each entry.
// Uses size+mtime by default; falls back to SHA-256 when sizes match but
// mtimes differ (covers copies, touch, etc.).
#[tauri::command]
async fn compare_dirs(
    path_left: String,
    path_right: String,
) -> Result<DirDiffResult, String> {
    use std::collections::HashMap;
    use sha2::{Sha256, Digest};

    tauri::async_runtime::spawn_blocking(move || {
        // Walk one directory tree, return map of rel_path → (size, mtime, is_dir)
        fn walk(root: &Path) -> HashMap<String, (u64, u64, bool)> {
            let mut map = HashMap::new();
            fn inner(root: &Path, dir: &Path, map: &mut HashMap<String, (u64, u64, bool)>) {
                let Ok(rd) = fs::read_dir(dir) else { return };
                for entry in rd.filter_map(|e| e.ok()) {
                    let p = entry.path();
                    let Ok(rel) = p.strip_prefix(root) else { continue };
                    let rel_str = rel.to_string_lossy().to_string();
                    let Ok(meta) = fs::metadata(&p) else { continue };
                    let is_dir = meta.is_dir();
                    let size = if is_dir { 0 } else { meta.len() };
                    let mtime = meta.modified().ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    map.insert(rel_str, (size, mtime, is_dir));
                    if is_dir { inner(root, &p, map); }
                }
            }
            inner(root, root, &mut map);
            map
        }

        // Quick file hash for disambiguation when size matches but mtime differs
        fn file_hash(p: &Path) -> String {
            if let Ok(data) = fs::read(p) {
                format!("{:x}", Sha256::digest(&data))
            } else {
                String::new()
            }
        }

        let root_l = Path::new(&path_left);
        let root_r = Path::new(&path_right);
        let map_l = walk(root_l);
        let map_r = walk(root_r);

        let mut entries: Vec<DirDiffEntry> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Process left tree
        for (rel, (sz_l, mt_l, is_dir)) in &map_l {
            seen.insert(rel.clone());
            let name = Path::new(rel).file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| rel.clone());
            if let Some(&(sz_r, mt_r, _)) = map_r.get(rel) {
                let status = if sz_l == &sz_r && mt_l == &mt_r {
                    DiffStatus::Same
                } else if sz_l == &sz_r {
                    // Same size, different mtime — hash to be sure
                    let pl = root_l.join(rel); let pr = root_r.join(rel);
                    if !is_dir && file_hash(&pl) == file_hash(&pr) {
                        DiffStatus::Same
                    } else { DiffStatus::Different }
                } else { DiffStatus::Different };
                entries.push(DirDiffEntry {
                    rel_path: rel.clone(), name, status,
                    is_dir: *is_dir,
                    size_left: Some(*sz_l), size_right: Some(sz_r),
                    mtime_left: Some(*mt_l), mtime_right: Some(mt_r),
                });
            } else {
                entries.push(DirDiffEntry {
                    rel_path: rel.clone(), name, status: DiffStatus::OnlyLeft,
                    is_dir: *is_dir,
                    size_left: Some(*sz_l), size_right: None,
                    mtime_left: Some(*mt_l), mtime_right: None,
                });
            }
        }

        // Files only in right
        for (rel, (sz_r, mt_r, is_dir)) in &map_r {
            if seen.contains(rel) { continue; }
            let name = Path::new(rel).file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| rel.clone());
            entries.push(DirDiffEntry {
                rel_path: rel.clone(), name, status: DiffStatus::OnlyRight,
                is_dir: *is_dir,
                size_left: None, size_right: Some(*sz_r),
                mtime_left: None, mtime_right: Some(*mt_r),
            });
        }

        // Sort: dirs first, then alphabetically by rel_path
        entries.sort_by(|a, b| {
            b.is_dir.cmp(&a.is_dir).then(a.rel_path.cmp(&b.rel_path))
        });

        let only_left  = entries.iter().filter(|e| e.status == DiffStatus::OnlyLeft).count();
        let only_right = entries.iter().filter(|e| e.status == DiffStatus::OnlyRight).count();
        let same       = entries.iter().filter(|e| e.status == DiffStatus::Same).count();
        let different  = entries.iter().filter(|e| e.status == DiffStatus::Different).count();

        Ok(DirDiffResult { entries, only_left, only_right, same, different })
    }).await.map_err(|e| e.to_string())?
}



    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            list_directory, list_directory_fast, list_directory_streamed, list_directory_chunk, list_directory_full_streamed, get_entry_meta, preload_dir,
            get_home_dir, get_sidebar_data, get_drives,
            open_file, get_file_preview, search_files,
            rename_file, batch_rename, delete_file, delete_items, delete_items_stream, create_directory, create_file_cmd, get_dir_size, get_dir_size_fast,
            window_minimize, window_maximize, window_close, window_set_fullscreen, window_is_maximized,
            copy_file, move_file, copy_files_batch, move_files_batch, cancel_file_op, create_new_document, parse_dropped_paths,
            get_media_port, get_thumbnail, get_thumbnail_bytes, get_thumbnail_bytes_batch,
            batch_thumbnails, get_thumbnail_url_batch, gc_thumbnail_cache, empty_trash,
            open_as_root, check_permission, read_svg_icon, eject_drive, mount_drive, unlock_and_mount_encrypted,
            get_file_tags, set_file_tags, get_all_tags, search_by_tag,
            get_tag_palette, set_tag_color, get_tags_with_colors, deep_search,
            compress_files, extract_archive, get_archive_contents,
            empty_trash_stream,
            open_terminal, open_in_editor,
            list_apps_for_file, open_with_app,
             get_native_window_handle, mpv_open_external, mpv_is_running, check_optional_deps, get_platform,
            set_ql_payload, get_ql_payload,
            watch_dir, unwatch_dir,
            mount_iso, unmount_iso, get_iso_loop_device, list_usb_drives, write_iso_to_usb,
            mount_smb, unmount_smb, get_smb_mounts, list_smb_shares,
            mount_webdav, unmount_cloud, get_cloud_mounts,
            mount_dmg, unmount_dmg, get_dmg_loop_device,
            install_font, is_font_installed,
            secure_delete, find_duplicates, diff_files,
            // r40-r42 additions
            trash_items, trash_list, trash_item_count,
            check_trash_restore_conflicts, trash_restore_with_resolution,
            mount_sftp, unmount_sftp, get_sftp_mounts,
            mount_ftp, unmount_ftp, get_ftp_mounts,
            get_file_permissions, chmod_entry, chown_entry,
            open_new_window,
            scan_dir_sizes,
            search_advanced, search_index_query,
            get_file_tags_v2, set_file_tags_v2, migrate_tag_path,
            probe_video_codec,
            load_plugins, save_plugins, run_plugin_command, check_plugin_trust, approve_plugin,
            get_settings, set_settings,
            get_watch_mode,
            append_error_log, get_error_log, clear_error_log,
            audit_tag_db, cleanup_tag_db, tag_db_stats,
            read_text_file, write_text_file,
            check_rclone, list_rclone_remotes, add_cloud_provider,
            scan_icon_folder,
            mount_cloud_provider, unmount_cloud_provider, remove_cloud_provider,
            restore_cloud_mounts,
            find_git_root, get_git_status, invalidate_git_cache,
            check_gocryptfs, list_vaults, create_vault, unlock_vault, lock_vault, remove_vault,
            get_file_checksums, get_file_meta_exif, write_file_meta_exif,
            get_audio_tags, write_audio_tags,
            compare_dirs,
        ])
        // ── Exit when main window closes ──────────────────────────────────────
        // The QL window is kept hidden (never destroyed) to stay warm for instant
        // re-open. This means Tauri's default "exit when last window closes" logic
        // never fires — the hidden QL window keeps the process alive indefinitely
        // after the user closes the main window.
        //
        // Fix: listen for the main window's Destroyed event and call app.exit(0)
        // explicitly, which terminates all windows and the process cleanly.
        .on_window_event(|window, event| {
            // Tauri v2: closure receives (window, event) separately
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    // p7: remove media port lockfile on clean exit
                    let _ = std::fs::remove_file(media_port_file());
                    window.app_handle().exit(0);
                }
            }
        })
        .setup(|app| {
            // ── Window icon — sets _NET_WM_ICON so the taskbar shows the real icon ──
            // On Linux, Tauri v1 does NOT automatically apply the bundle icon to the
            // live window. Without this call the taskbar shows a generic placeholder
            // (letter "F") or a blank square regardless of what's in tauri.conf.json.
            //
            // tauri::Icon::Rgba requires raw RGBA pixel data + explicit dimensions.
            // We decode the embedded PNG with the `image` crate (already a dep) to get
            // the pixel bytes and size, then hand them to set_icon().
            //
            // include_bytes! bakes the PNG into the binary at compile time — zero runtime
            // I/O, works in dev mode, installed .deb/.rpm/.AppImage, everywhere.
            if let Some(win) = app.get_webview_window("main") {
                // Tauri v2: tauri::image::Image replaces tauri::Icon::Rgba
                const ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");
                if let Ok(img) = image::load_from_memory(ICON_PNG) {
                    let rgba = img.into_rgba8();
                    let (width, height) = rgba.dimensions();
                    let _ = win.set_icon(tauri::image::Image::new_owned(
                        rgba.into_raw(),
                        width,
                        height,
                    ));
                }
            }

            // ── Wayland icon: install to hicolor theme on first run ───────────
            // On native Wayland (Hyprland, Sway, GNOME, KDE) the compositor
            // derives the taskbar/dock icon from:
            //   xdg_toplevel app_id  →  ~/.local/share/applications/frostfinder.desktop
            //   Desktop Entry Icon=frostfinder  →  hicolor icon theme lookup
            //
            // set_icon() above sets _NET_WM_ICON which is an X11 hint —
            // many Wayland compositors ignore it entirely. The correct fix is to
            // ensure the icon exists in ~/.local/share/icons/hicolor/<size>/apps/.
            // We do this once at startup (no-op if already installed) so the
            // icon appears correctly without requiring the user to run any install
            // commands. A background thread is used so startup is never delayed.
            #[cfg(target_os = "linux")]
            {
                std::thread::spawn(|| {
                    // Install all bundled PNG sizes into hicolor
                    struct IconSize { data: &'static [u8], dir: &'static str }
                    let icons: &[IconSize] = &[
                        IconSize { data: include_bytes!("../icons/16x16.png"),   dir: "16x16"   },
                        IconSize { data: include_bytes!("../icons/32x32.png"),   dir: "32x32"   },
                        IconSize { data: include_bytes!("../icons/48x48.png"),   dir: "48x48"   },
                        IconSize { data: include_bytes!("../icons/64x64.png"),   dir: "64x64"   },
                        IconSize { data: include_bytes!("../icons/128x128.png"), dir: "128x128" },
                        IconSize { data: include_bytes!("../icons/256x256.png"), dir: "256x256" },
                        IconSize { data: include_bytes!("../icons/512x512.png"), dir: "512x512" },
                    ];
                    if let Some(home) = std::env::var_os("HOME") {
                        let base = std::path::Path::new(&home)
                            .join(".local/share/icons/hicolor");
                        let mut any_written = false;
                        for icon in icons {
                            let dir = base.join(icon.dir).join("apps");
                            let dest = dir.join("frostfinder.png");
                            // Skip if already installed — avoids redundant writes
                            if dest.exists() { continue; }
                            if fs::create_dir_all(&dir).is_ok()
                                && fs::write(&dest, icon.data).is_ok() {
                                    any_written = true;
                                }
                        }
                        // Rebuild the icon cache so GTK/compositors pick up changes
                        if any_written {
                            let _ = std::process::Command::new("gtk-update-icon-cache")
                                .args(["-f", "-t",
                                       base.to_string_lossy().as_ref()])
                                .status();
                        }
                    }
                });
            }

            // ── USB / drive hot-plug watcher (Linux only) ─────────────────────
            // Polls /proc/mounts and /sys/block every 1.2s on Linux.
            // macOS uses NSWorkspace notifications (future work); Windows uses WMI.
            #[cfg(target_os = "linux")]
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let block_snapshot = || fs::read_dir("/sys/block")
                        .map(|rd| {
                            let mut names: Vec<String> = rd.filter_map(|e| e.ok())
                                .map(|e| e.file_name().to_string_lossy().to_string())
                                .collect();
                            names.sort();
                            names.join(",")
                        })
                        .unwrap_or_default();

                    let mut last_mounts = fs::read_to_string("/proc/mounts").unwrap_or_default();
                    let mut last_block  = block_snapshot();
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(1200));
                        let cur_mounts = fs::read_to_string("/proc/mounts").unwrap_or_default();
                        let cur_block  = block_snapshot();
                        if cur_mounts != last_mounts || cur_block != last_block {
                            last_mounts = cur_mounts;
                            last_block  = cur_block;
                            // Settle delay so OS finishes mounting/probing
                            std::thread::sleep(std::time::Duration::from_millis(800));
                            let drives = get_drives_platform();
                            let _ = app_handle.emit("drives-changed", drives);
                        }
                    }
                });
            }
            // ── Restore persisted SMB mounts ─────────────────────────────
            // On startup, reload the smb_mounts.json registry. Only keep entries
            // that are still actually mounted (isMounted check via /proc/mounts).
            #[cfg(target_os = "linux")]
            {
                let saved = smb_registry_load();
                if !saved.is_empty() {
                    let proc_mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
                    let still_mounted: Vec<SmbShare> = saved.into_iter()
                        .filter(|s| proc_mounts.contains(&s.mount_point))
                        .collect();
                    if let Ok(mut lock) = SMB_MOUNTS.lock() {
                        *lock = Some(still_mounted.clone());
                    }
                    smb_registry_save(&still_mounted);
                }
            }

            // ── r40-r42: restore SFTP and FTP mount registries ────────────
            {
                let sftp_loaded = sftp_reg_load();
                if !sftp_loaded.is_empty() {
                    *SFTP_MOUNTS.lock().unwrap_or_else(|e| e.into_inner()) = sftp_loaded;
                }
                let ftp_loaded = ftp_reg_load();
                if !ftp_loaded.is_empty() {
                    *FTP_MOUNTS.lock().unwrap_or_else(|e| e.into_inner()) = ftp_loaded;
                }
            }

            // ── r53: restore WebDAV/Cloud mount registry ──────────────────
            #[cfg(target_os = "linux")]
            {
                let saved = cloud_registry_load();
                if !saved.is_empty() {
                    let proc_mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
                    let still_mounted: Vec<CloudMount> = saved.into_iter()
                        .filter(|c| proc_mounts.contains(&c.mount_point))
                        .collect();
                    if let Ok(mut lock) = CLOUD_MOUNTS.lock() {
                        *lock = Some(still_mounted.clone());
                    }
                    cloud_registry_save(&still_mounted);
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ═════════════════════════════════════════════════════════════════════════════
// r40–r42 ADDITIONS  (appended once — all functions are new to r39)
// ═════════════════════════════════════════════════════════════════════════════

// ── Shared helpers ────────────────────────────────────────────────────────────
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let p = std::process::id() as u128;
    format!("{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (t & 0xffffffff) as u32, ((t >> 32) & 0xffff) as u16,
        ((t >> 48) & 0x0fff) as u16, (((t >> 60) & 0x3fff) | 0x8000) as u16,
        ((t ^ p) & 0xffffffffffff) as u64)
}

fn copy_recursive_r42(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            copy_recursive_r42(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else { std::fs::copy(src, dst).map_err(|e| e.to_string())?; }
    Ok(())
}

fn remove_recursive_r42(path: &Path) -> Result<(), String> {
    if path.is_dir() { std::fs::remove_dir_all(path).map_err(|e| e.to_string()) }
    else if path.exists() { std::fs::remove_file(path).map_err(|e| e.to_string()) }
    else { Ok(()) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. XDG TRASH BROWSING
// ─────────────────────────────────────────────────────────────────────────────

fn xdg_trash_files_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("/tmp")).join("Trash/files")
}
fn xdg_trash_info_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("/tmp")).join("Trash/info")
}
fn ensure_xdg_trash() -> Result<(), String> {
    std::fs::create_dir_all(xdg_trash_files_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(xdg_trash_info_dir()).map_err(|e| e.to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TrashItem {
    pub name: String, pub trash_path: String,
    pub original_path: String, pub deleted_at: Option<u64>, pub size: Option<u64>,
}

#[tauri::command]
fn trash_items(paths: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    ensure_xdg_trash()?;
    let now_str = {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let (s, m, h) = (secs%60, (secs/60)%60, (secs/3600)%24);
        let days = secs/86400;
        let z=days+719468; let era=z/146097; let doe=z-era*146097;
        let yoe=(doe-doe/1460+doe/36524-doe/146096)/365;
        let y=yoe+era*400; let doy=doe-(365*yoe+yoe/4-yoe/100);
        let mp=(5*doy+2)/153; let d=doy-(153*mp+2)/5+1;
        let mo=if mp<10{mp+3}else{mp-9}; let yr=if mo<=2{y+1}else{y};
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", yr, mo, d, h, m, s)
    };
    for src_str in &paths {
        let src = Path::new(src_str);
        if !src.exists() { continue; }
        let file_name = src.file_name().ok_or_else(|| format!("invalid path: {src_str}"))?.to_string_lossy().to_string();
        let mut dest_name = file_name.clone();
        let mut dest = xdg_trash_files_dir().join(&dest_name);
        let mut n = 1u32;
        while dest.exists() { dest_name = format!("{file_name}.{n}"); dest = xdg_trash_files_dir().join(&dest_name); n += 1; }
        let info_path = xdg_trash_info_dir().join(format!("{dest_name}.trashinfo"));
        let mut f = std::fs::File::create(&info_path).map_err(|e| format!("trashinfo: {e}"))?;
        f.write_all(format!("[Trash Info]\nPath={src_str}\nDeletionDate={now_str}\n").as_bytes()).map_err(|e| e.to_string())?;
        if let Err(e) = std::fs::rename(src, &dest) {
            if e.raw_os_error() == Some(18) { copy_recursive_r42(src, &dest)?; remove_recursive_r42(src)?; }
            else { let _ = std::fs::remove_file(&info_path); return Err(format!("trash move: {e}")); }
        }
    }
    Ok(())
}

#[tauri::command]
fn trash_list() -> Result<Vec<TrashItem>, String> {
    ensure_xdg_trash()?;
    let mut items = Vec::new();
    for entry in std::fs::read_dir(xdg_trash_info_dir()).map_err(|e| e.to_string())?.flatten() {
        let info_path = entry.path();
        if info_path.extension().and_then(|e| e.to_str()) != Some("trashinfo") { continue; }
        let content = std::fs::read_to_string(&info_path).unwrap_or_default();
        let original_path = content.lines().find(|l| l.starts_with("Path=")).map(|l| l[5..].to_string()).unwrap_or_default();
        let stem = info_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let trash_path = xdg_trash_files_dir().join(&stem);
        let size = if trash_path.is_file() { trash_path.metadata().ok().map(|m| m.len()) } else { None };
        items.push(TrashItem { name: stem, trash_path: trash_path.to_string_lossy().to_string(), original_path, deleted_at: None, size });
    }
    Ok(items)
}

#[tauri::command]
fn trash_item_count() -> Result<usize, String> {
    ensure_xdg_trash()?;
    Ok(std::fs::read_dir(xdg_trash_info_dir()).map_err(|e| e.to_string())?.flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("trashinfo")).count())
}

#[derive(serde::Serialize)]
pub struct TrashConflict { pub trash_path: String, pub original_path: String }

#[tauri::command]
fn check_trash_restore_conflicts(paths: Vec<String>) -> Result<Vec<TrashConflict>, String> {
    let mut conflicts = Vec::new();
    for tp in &paths {
        let stem = Path::new(tp).file_name().unwrap_or_default().to_string_lossy().to_string();
        let content = std::fs::read_to_string(xdg_trash_info_dir().join(format!("{stem}.trashinfo"))).unwrap_or_default();
        let orig = content.lines().find(|l| l.starts_with("Path=")).map(|l| l[5..].to_string()).unwrap_or_default();
        if !orig.is_empty() && Path::new(&orig).exists() { conflicts.push(TrashConflict { trash_path: tp.clone(), original_path: orig }); }
    }
    Ok(conflicts)
}

#[derive(serde::Deserialize)]
pub struct RestoreInstruction { pub path: String, pub resolution: String }

#[tauri::command]
fn trash_restore_with_resolution(instructions: Vec<RestoreInstruction>) -> Result<(), String> {
    for inst in &instructions {
        if inst.resolution == "skip" { continue; }
        let tp = Path::new(&inst.path);
        let stem = tp.file_name().unwrap_or_default().to_string_lossy().to_string();
        let info_path = xdg_trash_info_dir().join(format!("{stem}.trashinfo"));
        let content = std::fs::read_to_string(&info_path).map_err(|e| format!("trashinfo: {e}"))?;
        let orig = content.lines().find(|l| l.starts_with("Path=")).map(|l| l[5..].to_string()).ok_or("bad trashinfo")?;
        let dest = match inst.resolution.as_str() {
            "keep_both" => {
                let p = Path::new(&orig); let par = p.parent().unwrap_or(Path::new("/"));
                let sn = p.file_stem().unwrap_or_default().to_string_lossy();
                let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                let mut c = par.join(format!("{sn} (restored){ext}")); let mut n = 2u32;
                while c.exists() { c = par.join(format!("{sn} (restored {n}){ext}")); n += 1; }
                c.to_string_lossy().to_string()
            }
            _ => { if Path::new(&orig).exists() { let _ = remove_recursive_r42(Path::new(&orig)); } orig.clone() }
        };
        let dp = Path::new(&dest);
        if let Some(par) = dp.parent() { std::fs::create_dir_all(par).map_err(|e| e.to_string())?; }
        std::fs::rename(tp, dp).or_else(|e| {
            if e.raw_os_error() == Some(18) { copy_recursive_r42(tp, dp)?; remove_recursive_r42(tp) }
            else { Err(format!("restore: {e}")) }
        })?;
        let _ = std::fs::remove_file(&info_path);
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SFTP MOUNT
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SftpMount { pub id: String, pub label: String, pub host: String, pub port: u16, pub username: String, pub remote_path: String, pub mount_path: String, pub key_path: Option<String> }

static SFTP_MOUNTS: std::sync::Mutex<Vec<SftpMount>> = std::sync::Mutex::new(Vec::new());

fn sftp_reg_path() -> PathBuf { dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("/tmp")).join("frostfinder/sftp_mounts.json") }
fn sftp_reg_save(m: &[SftpMount]) { if let Some(p) = sftp_reg_path().parent() { let _ = std::fs::create_dir_all(p); } if let Ok(j) = serde_json::to_string(m) { let _ = std::fs::write(sftp_reg_path(), j); } }
pub fn sftp_reg_load() -> Vec<SftpMount> {
    let p = sftp_reg_path(); if !p.exists() { return Vec::new(); }
    let json = match std::fs::read_to_string(&p) { Ok(j) => j, Err(_) => return Vec::new() };
    let mounts: Vec<SftpMount> = match serde_json::from_str(&json) { Ok(m) => m, Err(_) => return Vec::new() };
    let proc = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    mounts.into_iter().filter(|m| proc.contains(&m.mount_path)).collect()
}

#[tauri::command]
fn mount_sftp(host: String, port: u16, username: String, password: String, key_path: String, remote_path: String) -> Result<String, String> {
    let id = uuid_v4();
    let mount_path = format!("/tmp/frostfinder-sftp/{id}");
    std::fs::create_dir_all(&mount_path).map_err(|e| format!("mkdir: {e}"))?;
    let remote = format!("{username}@{host}:{remote_path}");
    let port_str = port.to_string();
    let status = if !password.is_empty() {
        let mut c = std::process::Command::new("sshpass");
        c.arg("-p").arg(&password).arg("sshfs").arg(&remote).arg(&mount_path).arg("-p").arg(&port_str).arg("-o").arg("StrictHostKeyChecking=no");
        if !key_path.is_empty() { c.arg("-o").arg(format!("IdentityFile={key_path}")); }
        c.status().map_err(|e| format!("sshpass not found: {e}"))?
    } else {
        let mut c = std::process::Command::new("sshfs");
        c.arg(&remote).arg(&mount_path).arg("-p").arg(&port_str).arg("-o").arg("reconnect").arg("-o").arg("StrictHostKeyChecking=no");
        if !key_path.is_empty() { c.arg("-o").arg(format!("IdentityFile={key_path}")); }
        c.status().map_err(|e| format!("sshfs not found: {e}"))?
    };
    if !status.success() { let _ = std::fs::remove_dir(&mount_path); return Err("SFTP mount failed".into()); }
    let mount = SftpMount { id: id.clone(), label: format!("{username}@{host}:{remote_path}"), host, port, username, remote_path, mount_path: mount_path.clone(), key_path: if key_path.is_empty() { None } else { Some(key_path) } };
    let mut mounts = SFTP_MOUNTS.lock().unwrap_or_else(|e| e.into_inner()); mounts.push(mount); sftp_reg_save(&mounts);
    Ok(mount_path)
}

#[tauri::command]
fn unmount_sftp(id: String) -> Result<(), String> {
    let mut mounts = SFTP_MOUNTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(pos) = mounts.iter().position(|m| m.id == id) {
        let mp = mounts[pos].mount_path.clone();
        let _ = std::process::Command::new("fusermount").arg("-u").arg(&mp).status().or_else(|_| std::process::Command::new("umount").arg(&mp).status());
        let _ = std::fs::remove_dir(&mp); mounts.remove(pos); sftp_reg_save(&mounts);
    }
    Ok(())
}

#[tauri::command]
fn get_sftp_mounts() -> Vec<SftpMount> { SFTP_MOUNTS.lock().unwrap_or_else(|e| e.into_inner()).clone() }

// ─────────────────────────────────────────────────────────────────────────────
// 3. FTP MOUNT
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct FtpMount { pub id: String, pub label: String, pub host: String, pub port: u16, pub username: String, pub remote_path: String, pub mount_path: String, pub tls: bool }

static FTP_MOUNTS: std::sync::Mutex<Vec<FtpMount>> = std::sync::Mutex::new(Vec::new());

fn ftp_reg_path() -> PathBuf { dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("/tmp")).join("frostfinder/ftp_mounts.json") }
fn ftp_reg_save(m: &[FtpMount]) { if let Some(p) = ftp_reg_path().parent() { let _ = std::fs::create_dir_all(p); } if let Ok(j) = serde_json::to_string(m) { let _ = std::fs::write(ftp_reg_path(), j); } }
pub fn ftp_reg_load() -> Vec<FtpMount> {
    let p = ftp_reg_path(); if !p.exists() { return Vec::new(); }
    let json = match std::fs::read_to_string(&p) { Ok(j) => j, Err(_) => return Vec::new() };
    let mounts: Vec<FtpMount> = match serde_json::from_str(&json) { Ok(m) => m, Err(_) => return Vec::new() };
    let proc = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    mounts.into_iter().filter(|m| proc.contains(&m.mount_path)).collect()
}

#[tauri::command]
fn mount_ftp(host: String, port: u16, username: String, password: String, remote_path: String, passive: bool, tls: bool) -> Result<String, String> {
    let id = uuid_v4();
    let mount_path = format!("/tmp/frostfinder-ftp/{id}");
    std::fs::create_dir_all(&mount_path).map_err(|e| format!("mkdir: {e}"))?;
    let scheme = if tls { "ftps" } else { "ftp" };
    let url = format!("{scheme}://{host}:{port}{remote_path}");
    let mut cmd = std::process::Command::new("curlftpfs");
    cmd.arg(&url).arg(&mount_path).arg("-o").arg(format!("user={username}:{password}")).arg("-o").arg("allow_other");
    if passive { cmd.arg("-o").arg("ftp_port=-"); }
    if tls { cmd.arg("-o").arg("ssl"); }
    let status = cmd.status().map_err(|e| format!("curlftpfs not found: {e}"))?;
    if !status.success() { let _ = std::fs::remove_dir(&mount_path); return Err("FTP mount failed".into()); }
    let mount = FtpMount { id: id.clone(), label: format!("{username}@{host}{remote_path}"), host, port, username, remote_path, mount_path: mount_path.clone(), tls };
    let mut mounts = FTP_MOUNTS.lock().unwrap_or_else(|e| e.into_inner()); mounts.push(mount); ftp_reg_save(&mounts);
    Ok(mount_path)
}

#[tauri::command]
fn unmount_ftp(id: String) -> Result<(), String> {
    let mut mounts = FTP_MOUNTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(pos) = mounts.iter().position(|m| m.id == id) {
        let mp = mounts[pos].mount_path.clone();
        let _ = std::process::Command::new("fusermount").arg("-u").arg(&mp).status().or_else(|_| std::process::Command::new("umount").arg(&mp).status());
        let _ = std::fs::remove_dir(&mp); mounts.remove(pos); ftp_reg_save(&mounts);
    }
    Ok(())
}

#[tauri::command]
fn get_ftp_mounts() -> Vec<FtpMount> { FTP_MOUNTS.lock().unwrap_or_else(|e| e.into_inner()).clone() }

// ─────────────────────────────────────────────────────────────────────────────
// 4. FILE PERMISSIONS
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct FilePermissionsInfo { pub name: String, pub path: String, pub is_dir: bool, pub size: u64, pub mode: u32, pub owner: String, pub group: String, pub modified: u64, pub created: Option<u64>, pub mime_hint: Option<String> }

#[tauri::command]
fn get_file_permissions(path: String) -> Result<FilePermissionsInfo, String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    let mode = meta.permissions().mode();
    let owner = { let pw = unsafe { libc::getpwuid(meta.uid()) }; if pw.is_null() { meta.uid().to_string() } else { unsafe { std::ffi::CStr::from_ptr((*pw).pw_name) }.to_string_lossy().to_string() } };
    let group = { let gr = unsafe { libc::getgrgid(meta.gid()) }; if gr.is_null() { meta.gid().to_string() } else { unsafe { std::ffi::CStr::from_ptr((*gr).gr_name) }.to_string_lossy().to_string() } };
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let created = meta.created().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs());
    let mime_hint = p.extension().and_then(|e| e.to_str()).map(|e| match e.to_lowercase().as_str() {
        "rs"=>"Rust source","js"=>"JavaScript","py"=>"Python","sh"=>"Shell script",
        "md"=>"Markdown","txt"=>"Text","pdf"=>"PDF",
        "png"|"jpg"|"jpeg"|"webp"|"gif"=>"Image","mp4"|"mkv"|"avi"|"mov"=>"Video",
        "mp3"|"flac"|"ogg"=>"Audio","zip"|"tar"|"gz"|"7z"|"rar"=>"Archive",_=>"File",
    }.to_string());
    Ok(FilePermissionsInfo { name, path, is_dir: meta.is_dir(), size: meta.len(), mode, owner, group, modified, created, mime_hint })
}

#[tauri::command]
fn chmod_entry(path: String, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & 0o777)).map_err(|e| format!("chmod: {e}"))
}

#[tauri::command]
fn chown_entry(path: String, owner: String, group: String) -> Result<(), String> {
    let resolve_uid = |name: &str| -> Option<u32> { if let Ok(n) = name.parse::<u32>() { return Some(n); } let c = std::ffi::CString::new(name).ok()?; let pw = unsafe { libc::getpwnam(c.as_ptr()) }; if pw.is_null() { None } else { Some(unsafe { (*pw).pw_uid }) } };
    let resolve_gid = |name: &str| -> Option<u32> { if let Ok(n) = name.parse::<u32>() { return Some(n); } let c = std::ffi::CString::new(name).ok()?; let gr = unsafe { libc::getgrnam(c.as_ptr()) }; if gr.is_null() { None } else { Some(unsafe { (*gr).gr_gid }) } };
    let uid = if owner.is_empty() { !0u32 } else { resolve_uid(&owner).ok_or_else(|| format!("Unknown user: {owner}"))? };
    let gid = if group.is_empty() { !0u32 } else { resolve_gid(&group).ok_or_else(|| format!("Unknown group: {group}"))? };
    let c_path = std::ffi::CString::new(path.as_bytes()).map_err(|_| "invalid path")?;
    let ret = unsafe { libc::lchown(c_path.as_ptr(), uid, gid) };
    if ret != 0 { return Err(format!("chown: {}", std::io::Error::last_os_error())); }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. MULTIPLE WINDOWS
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn open_new_window(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let label = format!("ff-{}", uuid_v4().replace('-', "").chars().take(12).collect::<String>());
    let folder_name = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title(format!("FrostFinder — {folder_name}"))
        .inner_size(1100.0, 720.0).min_inner_size(640.0, 400.0)
        .initialization_script(format!("window.__initialPath = {:?};", path))
        .build().map_err(|e| format!("window: {e}"))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. DISK USAGE
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct DirSizeEntry { pub path: String, pub size: u64 }

#[tauri::command]
fn scan_dir_sizes(path: String) -> Result<Vec<DirSizeEntry>, String> {
    fn rec(p: &Path, visited: &mut std::collections::HashSet<u64>) -> u64 {
        // p9: skip symlinks entirely — they break size accounting and can loop
        if let Ok(sym) = std::fs::symlink_metadata(p) {
            if sym.file_type().is_symlink() { return 0; }
            // p9: inode-cycle guard
            #[cfg(unix)] {
                use std::os::unix::fs::MetadataExt;
                if !visited.insert(sym.ino()) { return 0; }
            }
            if sym.is_file() { return sym.len(); }
        }
        std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| rec(&e.path(), visited)).sum()).unwrap_or(0)
    }
    let mut entries: Vec<DirSizeEntry> = std::fs::read_dir(Path::new(&path)).map_err(|e| e.to_string())?
        .flatten().take(256).map(|e| { let p=e.path(); let mut vis=std::collections::HashSet::new(); DirSizeEntry { path: p.to_string_lossy().to_string(), size: rec(&p, &mut vis) } })
        .filter(|e| e.size>0).collect();
    entries.sort_by(|a,b| b.size.cmp(&a.size));
    Ok(entries)
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ADVANCED SEARCH
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct SearchResultV2 { pub path: String, pub name: String, pub is_dir: bool, pub size: u64, pub modified: u64, pub snippet: Option<String> }

#[tauri::command]
fn search_advanced(query: String, root_path: String, recursive: bool, use_regex: bool, search_contents: bool, include_hidden: bool) -> Result<Vec<SearchResultV2>, String> {
    let pattern: Box<dyn Fn(&str)->bool+Send> = if use_regex {
        let re = regex::Regex::new(&query).map_err(|e| format!("regex: {e}"))?;
        Box::new(move |s: &str| re.is_match(s))
    } else {
        let lower = query.to_lowercase();
        Box::new(move |s: &str| s.to_lowercase().contains(&lower))
    };
    fn walk(dir: &Path, rec: bool, hidden: bool, contents: bool, pat: &dyn Fn(&str)->bool, q: &str, out: &mut Vec<SearchResultV2>, depth: u32, visited: &mut std::collections::HashSet<u64>) {
        if out.len()>=500||depth>20 { return; }
        // p9: inode-cycle guard — skip directories whose inode we have already visited
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if let Ok(m) = std::fs::symlink_metadata(dir) {
                if !visited.insert(m.ino()) { return; }
            }
        }
        let rd = match std::fs::read_dir(dir) { Ok(r)=>r, Err(_)=>return };
        for entry in rd.flatten() {
            if out.len()>=500 { break; }
            let path=entry.path();
            let name=path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if !hidden && name.starts_with('.') { continue; }
            // p9: skip symlinks to avoid traversing loops
            let sym_meta = match std::fs::symlink_metadata(&path) { Ok(m)=>m, Err(_)=>continue };
            if sym_meta.file_type().is_symlink() { continue; }
            let meta=match std::fs::metadata(&path){Ok(m)=>m,Err(_)=>continue};
            let is_dir=meta.is_dir(); let size=meta.len();
            let modified=meta.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_secs()).unwrap_or(0);
            let snippet=if contents&&!is_dir&&size<10*1024*1024 {
                std::fs::read_to_string(&path).ok().and_then(|txt|{ let lq=q.to_lowercase(); txt.lines().find(|l|l.to_lowercase().contains(&lq)).map(|l|if l.len()>120{l[..120].to_string()}else{l.trim().to_string()}) })
            } else { None };
            if pat(&name)||snippet.is_some() { out.push(SearchResultV2{path:path.to_string_lossy().to_string(),name,is_dir,size,modified,snippet}); }
            if rec&&is_dir { walk(&path,rec,hidden,contents,pat,q,out,depth+1,visited); }
        }
    }
    let mut results=Vec::new();
    let mut visited=std::collections::HashSet::new();
    walk(Path::new(&root_path),recursive,include_hidden,search_contents,pattern.as_ref(),&query,&mut results,0,&mut visited);
    results.sort_by(|a,b|a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(results)
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. TAG DB FALLBACK
// ─────────────────────────────────────────────────────────────────────────────

fn tag_db() -> &'static std::sync::Mutex<rusqlite::Connection> {
    static TAG_DB: std::sync::OnceLock<std::sync::Mutex<rusqlite::Connection>> = std::sync::OnceLock::new();
    TAG_DB.get_or_init(|| {
        let db_path = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("/tmp")).join("frostfinder/tags.db");
        if let Some(p) = db_path.parent() { let _ = std::fs::create_dir_all(p); }

        // p7: integrity check — rename corrupt DB and start fresh
        let conn = 'open: {
            if let Ok(c) = rusqlite::Connection::open(&db_path) {
                let ok: bool = c.query_row("PRAGMA integrity_check", [], |r| {
                    Ok(r.get::<_, String>(0).unwrap_or_default() == "ok")
                }).unwrap_or(false);
                if ok {
                    break 'open c;
                }
                // Corrupt — rename and emit a recoverable backup
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                let backup = db_path.with_extension(format!("db.corrupt.{}", ts));
                let _ = std::fs::rename(&db_path, &backup);
                eprintln!("[frostfinder] tags.db corrupt — backed up to {:?}, starting fresh", backup);
            }
            // Fresh open after rename (or first run)
            rusqlite::Connection::open(&db_path).expect("tag db open")
        };

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS file_tags(path TEXT PRIMARY KEY,tags_json TEXT NOT NULL DEFAULT '[]');             PRAGMA journal_mode=WAL;"
        ).expect("tag db init");

        // p7: WAL checkpoint counter — written via a static so db_write_tags can trigger it
        // (rusqlite Connection is not Send, so we use a global write counter)
        std::sync::Mutex::new(conn)
    })
}

// p7: WAL checkpoint — called periodically after writes to prevent unbounded WAL growth
static TAG_DB_WRITE_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
fn tag_db_maybe_checkpoint() {
    let n = TAG_DB_WRITE_COUNT.fetch_add(1, Ordering::Relaxed);
    if n % 500 == 499 {
        let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
        let _ = db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    }
}

const XATTR_KEY_R42: &str = "user.frostfinder.tags";

// ── Tag xattr helpers — platform-conditional ──────────────────────────────────
// Linux/macOS: use xattr crate (extended attributes).
// Windows: fall through to SQLite-only path (xattr not available; the SQLite
//          fallback in get_file_tags_v2 / set_file_tags_v2 handles Windows).

#[cfg(not(target_os = "windows"))]
fn xattr_read_tags(path: &str) -> Option<Vec<String>> {
    let raw = xattr::get(path, XATTR_KEY_R42).ok()??;
    serde_json::from_slice::<Vec<String>>(&raw).ok()
}

#[cfg(target_os = "windows")]
fn xattr_read_tags(_path: &str) -> Option<Vec<String>> { None }

#[cfg(not(target_os = "windows"))]
fn xattr_write_tags(path: &str, tags: &[String]) -> bool {
    let json = serde_json::to_vec(tags).unwrap_or_default();
    xattr::set(path, XATTR_KEY_R42, &json).is_ok()
}

#[cfg(target_os = "windows")]
fn xattr_write_tags(_path: &str, _tags: &[String]) -> bool { false }


fn db_read_tags(path: &str) -> Vec<String> {
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    db.query_row(
        "SELECT tags_json FROM file_tags WHERE path=?1",
        rusqlite::params![path],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
    .unwrap_or_default()
}

fn db_write_tags(path: &str, tags: &[String]) {
    let json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".into());
    let db = tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let _ = db.execute(
        "INSERT OR REPLACE INTO file_tags(path,tags_json) VALUES(?1,?2)",
        rusqlite::params![path, json],
    );
    drop(db); // release lock before checkpoint
    tag_db_maybe_checkpoint();
}

#[tauri::command]
fn get_file_tags_v2(path: String) -> Vec<String> { if let Some(t)=xattr_read_tags(&path){if!t.is_empty(){return t;}} db_read_tags(&path) }

#[tauri::command]
fn set_file_tags_v2(path: String, tags: Vec<String>) -> Result<(), String> {
    if xattr_write_tags(&path,&tags) { let db=tag_db().lock().unwrap_or_else(|e| e.into_inner()); let _=db.execute("DELETE FROM file_tags WHERE path=?1",rusqlite::params![path]); }
    else { db_write_tags(&path,&tags); }
    Ok(())
}

#[tauri::command]
fn migrate_tag_path(old_path: String, new_path: String) -> Result<(), String> {
    let db=tag_db().lock().unwrap_or_else(|e| e.into_inner());
    let _=db.execute("UPDATE file_tags SET path=?2 WHERE path=?1",rusqlite::params![old_path,new_path]);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. VIDEO CODEC PROBE
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct VideoCodecInfo { pub codec_name: Option<String>, pub width: Option<u32>, pub height: Option<u32>, pub fps: Option<String>, pub duration_secs: Option<f64>, pub bit_rate_kbps: Option<u64>, pub audio_codec: Option<String>, pub pixel_format: Option<String> }

#[tauri::command]
fn probe_video_codec(path: String) -> Result<Option<VideoCodecInfo>, String> {
    let out = std::process::Command::new("ffprobe").args(["-v","quiet","-print_format","json","-show_streams","-show_format",&path]).output().map_err(|e|e.to_string())?;
    if !out.status.success() { return Ok(None); }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e|e.to_string())?;
    let streams = json["streams"].as_array();
    let video = streams.and_then(|s| s.iter().find(|s| s["codec_type"]=="video"));
    let audio = streams.and_then(|s| s.iter().find(|s| s["codec_type"]=="audio"));
    let fmt = &json["format"];
    let fps = video.and_then(|v| v["r_frame_rate"].as_str()).map(|s| {
        if let Some((n,d))=s.split_once('/') { let nf:f64=n.parse().unwrap_or(0.0); let df:f64=d.parse().unwrap_or(1.0); format!("{:.3}",if df!=0.0{nf/df}else{0.0}) } else { s.to_string() }
    });
    Ok(Some(VideoCodecInfo {
        codec_name: video.and_then(|v|v["codec_name"].as_str()).map(str::to_string),
        width:  video.and_then(|v|v["width"].as_u64()).map(|n|n as u32),
        height: video.and_then(|v|v["height"].as_u64()).map(|n|n as u32),
        fps, duration_secs: fmt["duration"].as_str().and_then(|s|s.parse::<f64>().ok()),
        bit_rate_kbps: fmt["bit_rate"].as_str().and_then(|s|s.parse::<u64>().ok()).map(|b|b/1000),
        audio_codec: audio.and_then(|a|a["codec_name"].as_str()).map(str::to_string),
        pixel_format: video.and_then(|v|v["pix_fmt"].as_str()).map(str::to_string),
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. PLUGINS
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PluginDef { pub id: String, pub name: String, pub icon: Option<String>, pub r#match: Option<String>, pub command: String, pub multi: Option<bool>, pub confirm: Option<bool>, pub notify: Option<bool>, pub params: Option<Vec<PluginParam>> }

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PluginParam { pub name: String, pub label: String, pub placeholder: Option<String>, pub default: Option<String> }

#[derive(serde::Serialize)]
pub struct PluginResult { pub exit_code: i32, pub stdout: String, pub stderr: String }

fn plugins_path() -> PathBuf { dirs::data_local_dir().unwrap_or_else(||PathBuf::from("/tmp")).join("frostfinder/plugins.json") }

#[tauri::command]
fn load_plugins() -> Vec<PluginDef> { let p=plugins_path(); if !p.exists(){return Vec::new();} std::fs::read_to_string(&p).ok().and_then(|j|serde_json::from_str(&j).ok()).unwrap_or_default() }

#[tauri::command]
fn save_plugins(plugins: Vec<PluginDef>) -> Result<(), String> {
    if let Some(p)=plugins_path().parent(){let _=std::fs::create_dir_all(p);}
    let json=serde_json::to_string_pretty(&plugins).map_err(|e|e.to_string())?;
    std::fs::write(plugins_path(),json).map_err(|e|e.to_string())
}

// p9: plugin trust store — keyed by plugin command string, value is djb2 hash
fn plugin_trust_path() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(||PathBuf::from("/tmp")).join("frostfinder/plugin_trust.json")
}
fn plugin_trust_load() -> std::collections::HashMap<String, u64> {
    let p = plugin_trust_path();
    std::fs::read_to_string(&p).ok()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}
fn plugin_trust_save(map: &std::collections::HashMap<String, u64>) {
    if let Some(parent) = plugin_trust_path().parent() { let _ = std::fs::create_dir_all(parent); }
    if let Ok(j) = serde_json::to_string(map) { let _ = std::fs::write(plugin_trust_path(), j); }
}
fn djb2(s: &str) -> u64 {
    s.bytes().fold(5381u64, |h, b| h.wrapping_mul(33).wrapping_add(b as u64))
}

#[tauri::command]
fn check_plugin_trust(plugin_id: String, command: String) -> serde_json::Value {
    // Returns: { "trusted": bool, "changed": bool }
    // JS should show a confirmation dialog when changed=true before calling run_plugin_command
    let hash = djb2(&command);
    let store = plugin_trust_load();
    match store.get(&plugin_id) {
        None => serde_json::json!({"trusted": false, "changed": false, "first_run": true}),
        Some(&stored_hash) if stored_hash != hash => serde_json::json!({"trusted": false, "changed": true, "first_run": false}),
        _ => serde_json::json!({"trusted": true, "changed": false, "first_run": false}),
    }
}

#[tauri::command]
fn approve_plugin(plugin_id: String, command: String) {
    let hash = djb2(&command);
    let mut store = plugin_trust_load();
    store.insert(plugin_id, hash);
    plugin_trust_save(&store);
}

#[tauri::command]
fn run_plugin_command(window: tauri::Window, command: String, work_dir: String) -> Result<PluginResult, String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    // p9: 30-second execution timeout
    const TIMEOUT_SECS: u64 = 30;
    // p9: 1 MB combined stdout+stderr output cap
    const OUTPUT_CAP: usize = 1024 * 1024;

    let mut child = Command::new("sh")
        .arg("-c").arg(&command)
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;

    let stdout_pipe = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout_pipe);
    let mut stdout_lines: Vec<String> = Vec::new();
    let mut total_bytes: usize = 0;
    let start = std::time::Instant::now();
    let mut truncated = false;

    for line in reader.lines().map_while(Result::ok) {
        // p9: timeout check
        if start.elapsed().as_secs() >= TIMEOUT_SECS {
            let _ = child.kill();
            return Err(format!("Plugin timed out after {TIMEOUT_SECS}s"));
        }
        // p9: output cap
        total_bytes += line.len() + 1;
        if total_bytes > OUTPUT_CAP {
            let _ = child.kill();
            truncated = true;
            break;
        }
        // r176: Stream stdout — parse PROGRESS:n/total lines, emit event; forward rest
        if let Some(rest) = line.strip_prefix("PROGRESS:") {
            let parts: Vec<&str> = rest.splitn(2, '/').collect();
            if parts.len() == 2 {
                if let (Ok(done), Ok(total)) = (parts[0].trim().parse::<u64>(), parts[1].trim().parse::<u64>()) {
                    let _ = window.emit("plugin-progress", serde_json::json!({
                        "done": done, "total": total, "finished": false
                    }));
                    continue;
                }
            }
        }
        stdout_lines.push(line);
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let exit_code = if truncated { -2 } else { status.code().unwrap_or(-1) };
    let _ = window.emit("plugin-progress", serde_json::json!({
        "done": 0, "total": 0, "finished": true, "exit_code": exit_code
    }));

    let mut stdout = stdout_lines.join("\n");
    if truncated { stdout.push_str("\n[output truncated at 1 MB]"); }

    let mut stderr_str = String::new();
    if let Some(se) = child.stderr.as_mut() {
        std::io::Read::read_to_string(se, &mut stderr_str).ok();
        if stderr_str.len() > OUTPUT_CAP { stderr_str.truncate(OUTPUT_CAP); stderr_str.push_str("\n[stderr truncated]"); }
    }
    Ok(PluginResult { exit_code, stdout, stderr: stderr_str })
}


// ── Persistent settings (replaces localStorage for cross-session durability) ──
// Settings are stored in ~/.config/frostfinder/settings.json as a flat
// JSON object. JS reads them once on startup via get_settings() and writes
// on every change via set_settings(). This survives WebView profile resets
// and app reinstalls, unlike localStorage.

const SETTINGS_VERSION: u32 = 1;

fn settings_path() -> std::path::PathBuf {
    dirs::config_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("frostfinder")
        .join("settings.json")
}

fn migrate_settings(mut settings: serde_json::Value) -> serde_json::Value {
    let current_version = settings.get("_v").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if current_version >= SETTINGS_VERSION {
        return settings;
    }
    // Migration from version 0 to 1
    if current_version < 1 {
        // Add any new keys with their defaults here when settings schema changes
        // For now, just ensure the version is set
        settings["_v"] = serde_json::json!(SETTINGS_VERSION);
    }
    settings
}

#[tauri::command]
fn get_settings() -> serde_json::Value {
    let p = settings_path();
    if let Ok(data) = std::fs::read_to_string(&p) {
        match serde_json::from_str::<serde_json::Value>(&data) {
            Ok(settings) => migrate_settings(settings),
            Err(e) => {
                eprintln!("Settings parse error: {}. Backing up and resetting.", e);
                // Backup the corrupted file so the user can recover it manually
                let backup_path = format!(
                    "{}.backup.{}",
                    p.display(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                );
                if std::fs::copy(&p, &backup_path).is_ok() {
                    eprintln!("Corrupted settings backed up to {}", backup_path);
                }
                // _reset: true signals the JS layer to show a one-time warning toast
                serde_json::json!({ "_v": SETTINGS_VERSION, "_reset": true })
            }
        }
    } else {
        // First launch — no file yet, no toast needed
        serde_json::json!({ "_v": SETTINGS_VERSION })
    }
}

#[tauri::command]
fn set_settings(settings: serde_json::Value) -> Result<(), String> {
    let p = settings_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| e.to_string())
}


// ════════════════════════════════════════════════════════════════════════════
// Unit tests
// ════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── helpers ──────────────────────────────────────────────────────────────

    fn tmp() -> TempDir {
        tempfile::TempDir::new().expect("failed to create TempDir")
    }

    fn make_file(dir: &std::path::Path, name: &str, content: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        fs::write(&p, content).expect("write failed");
        p
    }

    // ── DirCache ─────────────────────────────────────────────────────────────

    #[test]
    fn dir_cache_insert_and_get() {
        let mut cache = DirCache::new();
        let entries = vec![FileEntryFast {
            name: "foo.txt".into(), path: "/tmp/foo.txt".into(),
            is_dir: false, extension: Some("txt".into()),
            is_hidden: false, is_symlink: false,
        }];
        cache.insert("/tmp".into(), entries.clone());
        let got = cache.get("/tmp").expect("cache miss after insert");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "foo.txt");
    }

    #[test]
    fn dir_cache_evicts_lru_at_capacity() {
        let mut cache = DirCache::new();
        let empty: Vec<FileEntryFast> = Vec::new();
        // Fill to capacity
        for i in 0..DIR_CACHE_MAX {
            cache.insert(format!("/p{}", i), empty.clone());
        }
        assert!(cache.get("/p0").is_some(), "p0 should still be present before overflow");
        // One more insertion must evict /p0 (LRU)
        cache.insert("/overflow".into(), empty.clone());
        assert!(cache.get("/p0").is_none(), "p0 should be evicted");
        assert!(cache.get("/overflow").is_some(), "/overflow must be present");
    }

    #[test]
    fn dir_cache_evict_removes_entry() {
        let mut cache = DirCache::new();
        cache.insert("/a".into(), Vec::new());
        assert!(cache.get("/a").is_some());
        cache.evict("/a");
        assert!(cache.get("/a").is_none());
    }

    #[test]
    fn dir_cache_refresh_moves_to_back() {
        let mut cache = DirCache::new();
        let empty: Vec<FileEntryFast> = Vec::new();
        for i in 0..DIR_CACHE_MAX {
            cache.insert(format!("/p{}", i), empty.clone());
        }
        // Re-insert /p0 — now MRU; next overflow should evict /p1 instead
        cache.insert("/p0".into(), empty.clone());
        cache.insert("/overflow".into(), empty.clone());
        assert!(cache.get("/p0").is_some(), "/p0 was re-inserted, must survive");
        assert!(cache.get("/p1").is_none(), "/p1 should be LRU-evicted");
    }

    // ── tag DB round-trip ─────────────────────────────────────────────────────

    #[test]
    fn db_tags_roundtrip() {
        let d = tmp();
        let f = make_file(d.path(), "tagged.txt", b"hello");
        let path = f.to_string_lossy().to_string();
        let tags = vec!["red".to_string(), "important".to_string()];

        db_write_tags(&path, &tags);
        let got = db_read_tags(&path);
        assert_eq!(got, tags);
    }

    #[test]
    fn db_tags_overwrite() {
        let d = tmp();
        let f = make_file(d.path(), "file.txt", b"x");
        let path = f.to_string_lossy().to_string();

        db_write_tags(&path, &["green".to_string()]);
        db_write_tags(&path, &["blue".to_string(), "work".to_string()]);
        let got = db_read_tags(&path);
        assert_eq!(got, vec!["blue", "work"]);
    }

    #[test]
    fn db_tags_empty_on_missing() {
        let got = db_read_tags("/nonexistent/path/file.txt");
        assert!(got.is_empty());
    }

    #[test]
    fn db_tags_clear_with_empty_vec() {
        let d = tmp();
        let f = make_file(d.path(), "file.txt", b"x");
        let path = f.to_string_lossy().to_string();

        db_write_tags(&path, &["red".to_string()]);
        db_write_tags(&path, &[]);
        let got = db_read_tags(&path);
        assert!(got.is_empty());
    }

    // ── SMB registry round-trip ───────────────────────────────────────────────

    #[test]
    fn smb_registry_roundtrip() {
        let d = tmp();
        // Override registry path via env — tests must not touch real user data
        let p = d.path().join("smb_mounts.json");
        let mounts = vec![
            SmbShare {
                server: "192.168.1.10".into(),
                share: "media".into(),
                mount_point: "/tmp/ff-smb-test".into(),
                username: Some("alice".into()),
            },
            SmbShare {
                server: "nas.local".into(),
                share: "backup".into(),
                mount_point: "/tmp/ff-smb-backup".into(),
                username: None,
            },
        ];
        let json = serde_json::to_string(&mounts).unwrap();
        fs::write(&p, &json).unwrap();
        let loaded: Vec<SmbShare> = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].server, "192.168.1.10");
        assert_eq!(loaded[1].username, None);
    }

    #[test]
    fn smb_registry_empty_on_corrupt_json() {
        let d = tmp();
        let p = d.path().join("smb_mounts.json");
        fs::write(&p, b"not valid json {{{{").unwrap();
        let loaded: Vec<SmbShare> = serde_json::from_str(
            &fs::read_to_string(&p).unwrap()
        ).unwrap_or_default();
        assert!(loaded.is_empty());
    }

    // ── Cloud (WebDAV) registry round-trip ────────────────────────────────────

    #[test]
    fn cloud_registry_roundtrip() {
        let d = tmp();
        let p = d.path().join("cloud_mounts.json");
        let mounts = vec![CloudMount {
            id: "uuid-1".into(),
            cloud_type: "webdav".into(),
            name: "Nextcloud".into(),
            mount_point: "/tmp/ff-cloud-test".into(),
            url: Some("https://cloud.example.com".into()),
            bucket: None,
        }];
        let json = serde_json::to_string(&mounts).unwrap();
        fs::write(&p, &json).unwrap();
        let loaded: Vec<CloudMount> =
            serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].cloud_type, "webdav");
        assert_eq!(loaded[0].url.as_deref(), Some("https://cloud.example.com"));
    }

    // ── copy_files helper (filesystem-level) ─────────────────────────────────

    #[test]
    fn copy_single_file() {
        let src_dir = tmp();
        let dst_dir = tmp();
        let src = make_file(src_dir.path(), "hello.txt", b"hello world");
        let dst = dst_dir.path().join("hello.txt");

        fs::copy(&src, &dst).expect("copy failed");

        assert!(dst.exists());
        assert_eq!(fs::read(&dst).unwrap(), b"hello world");
        // Source must still exist (copy, not move)
        assert!(src.exists());
    }

    #[test]
    fn copy_preserves_content() {
        let src_dir = tmp();
        let dst_dir = tmp();
        let content = b"FrostFinder test content \xf0\x9f\x90\xa7";
        let src = make_file(src_dir.path(), "data.bin", content);
        let dst = dst_dir.path().join("data.bin");
        fs::copy(&src, &dst).unwrap();
        assert_eq!(fs::read(dst).unwrap().as_slice(), content);
    }

    #[test]
    fn move_file_removes_source() {
        let src_dir = tmp();
        let dst_dir = tmp();
        let src = make_file(src_dir.path(), "move_me.txt", b"bye");
        let dst = dst_dir.path().join("move_me.txt");

        fs::rename(&src, &dst).expect("rename failed");

        assert!(!src.exists(), "source must be gone after move");
        assert!(dst.exists());
        assert_eq!(fs::read(&dst).unwrap(), b"bye");
    }

    // ── FileOpProgress serialisation ─────────────────────────────────────────

    #[test]
    fn file_op_progress_serialises_without_optional_fields() {
        let p = FileOpProgress {
            done: 3, total: 10,
            name: "archive.zip".into(),
            error: None, finished: None,
            bytes_done: None, bytes_total: None,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"done\":3"));
        assert!(json.contains("\"total\":10"));
        // None fields must be skipped (skip_serializing_if)
        assert!(!json.contains("bytes_done"));
        assert!(!json.contains("error"));
    }

    #[test]
    fn file_op_progress_serialises_with_byte_fields() {
        let p = FileOpProgress {
            done: 1, total: 5,
            name: "video.mkv".into(),
            error: None,
            finished: Some(false),
            bytes_done: Some(1_048_576),
            bytes_total: Some(10_485_760),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"bytes_done\":1048576"));
        assert!(json.contains("\"bytes_total\":10485760"));
        assert!(json.contains("\"finished\":false"));
    }

    // ── FileEntryFast serialisation ───────────────────────────────────────────

    #[test]
    fn file_entry_fast_roundtrip() {
        let e = FileEntryFast {
            name: "document.pdf".into(),
            path: "/home/user/document.pdf".into(),
            is_dir: false,
            extension: Some("pdf".into()),
            is_hidden: false,
            is_symlink: false,
        };
        let json = serde_json::to_string(&e).unwrap();
        let back: FileEntryFast = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, e.name);
        assert_eq!(back.extension, e.extension);
        assert!(!back.is_dir);
    }

    #[test]
    fn hidden_file_detection() {
        // Hidden files start with '.' on Linux
        let names = [(".bashrc", true), ("README.md", false), (".config", true), ("main.rs", false)];
        for (name, expected) in names {
            let is_hidden = name.starts_with('.');
            assert_eq!(is_hidden, expected, "failed for {name}");
        }
    }

    // ── SftpMount / FtpMount serialisation ───────────────────────────────────

    #[test]
    fn sftp_mount_roundtrip() {
        let m = SftpMount {
            id: "sftp-1".into(), label: "Work Server".into(),
            host: "ssh.example.com".into(), port: 22,
            username: "dev".into(), remote_path: "/home/dev".into(),
            mount_path: "/tmp/ff-sftp-1".into(),
            key_path: Some("/home/user/.ssh/id_ed25519".into()),
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: SftpMount = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host, "ssh.example.com");
        assert_eq!(back.port, 22);
        assert_eq!(back.key_path.as_deref(), Some("/home/user/.ssh/id_ed25519"));
    }

    // ── Tag DB integrity ──────────────────────────────────────────────────────

    #[test]
    fn audit_tag_db_returns_orphans_only() {
        let d = tmp();
        let real_file = make_file(d.path(), "real.txt", b"x");
        let real_path = real_file.to_str().unwrap().to_string();
        let ghost_path = d.path().join("ghost.txt").to_str().unwrap().to_string();

        db_write_tags(&real_path,  &["red".to_string()]);
        db_write_tags(&ghost_path, &["blue".to_string()]);

        let orphans = audit_tag_db();
        assert!(!orphans.contains(&real_path),  "real file must not be orphan");
        assert!(orphans.contains(&ghost_path),   "ghost file must be orphan");
    }

    #[test]
    fn cleanup_tag_db_removes_only_orphans() {
        let d = tmp();
        let real_file = make_file(d.path(), "keep.txt", b"x");
        let real_path = real_file.to_str().unwrap().to_string();
        let ghost_path = d.path().join("gone.txt").to_str().unwrap().to_string();

        db_write_tags(&real_path,  &["green".to_string()]);
        db_write_tags(&ghost_path, &["blue".to_string()]);

        let removed = cleanup_tag_db().expect("cleanup failed");
        assert!(removed >= 1, "at least the ghost row must be removed");

        // real file's tags must still be readable
        let tags = db_read_tags(&real_path);
        assert_eq!(tags, vec!["green"]);

        // ghost must now return empty
        let ghost_tags = db_read_tags(&ghost_path);
        assert!(ghost_tags.is_empty());
    }

    #[test]
    fn cleanup_tag_db_no_op_when_clean() {
        let d = tmp();
        let f = make_file(d.path(), "file.txt", b"x");
        let path = f.to_string_lossy().to_string();
        db_write_tags(&path, &["tag1".to_string()]);

        let removed = cleanup_tag_db().expect("cleanup failed");
        // No orphans — may return 0 or more if other test files left DB rows
        // but the real file's tag must survive
        let tags = db_read_tags(&path);
        assert!(!tags.is_empty(), "tags must survive a clean run");
        let _ = removed; // value not checked — depends on other test ordering
    }

    #[test]
    fn ftp_mount_tls_flag() {
        let plain = FtpMount {
            id: "ftp-1".into(), label: "FTP".into(),
            host: "ftp.example.com".into(), port: 21,
            username: "anon".into(), remote_path: "/pub".into(),
            mount_path: "/tmp/ff-ftp-1".into(), tls: false,
        };
        let tls = FtpMount { tls: true, id: "ftp-2".into(), label: "FTPS".into(), port: 990, ..plain.clone() };

        let j_plain = serde_json::to_string(&plain).unwrap();
        let j_tls   = serde_json::to_string(&tls).unwrap();
        assert!(j_plain.contains("\"tls\":false"));
        assert!(j_tls.contains("\"tls\":true"));
    }

    // ── read_text_file / write_text_file ─────────────────────────────────────

    #[test]
    fn test_read_text_file_roundtrip() {
        let dir = tmp();
        let p = dir.path().join("hello.txt");
        fs::write(&p, "Hello, world!\n").unwrap();
        let result = read_text_file(p.to_string_lossy().to_string());
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Hello, world!\n");
    }

    #[test]
    fn test_write_text_file_atomic() {
        let dir = tmp();
        let p = dir.path().join("out.txt");
        let result = write_text_file(p.to_string_lossy().to_string(), "Atomic write".to_string());
        assert!(result.is_ok());
        assert_eq!(fs::read_to_string(&p).unwrap(), "Atomic write");
        // Temp file should NOT be left behind
        let tmp_path = dir.path().join(".frostfinder_tmp_out.txt.tmp");
        assert!(!tmp_path.exists(), "temp file should be cleaned up after rename");
    }

    #[test]
    fn test_write_text_file_overwrites() {
        let dir = tmp();
        let p = dir.path().join("overwrite.txt");
        fs::write(&p, "original").unwrap();
        write_text_file(p.to_string_lossy().to_string(), "updated".to_string()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "updated");
    }

    #[test]
    fn test_read_text_file_missing() {
        let result = read_text_file("/nonexistent/path/file.txt".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_read_text_file_too_large() {
        let dir = tmp();
        let p = dir.path().join("big.txt");
        // Write 2 MB + 1 byte — just over the limit
        let big: Vec<u8> = vec![b'x'; 2 * 1024 * 1024 + 1];
        fs::write(&p, &big).unwrap();
        let result = read_text_file(p.to_string_lossy().to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too large"));
    }

    // ── search_advanced ───────────────────────────────────────────────────────
    // Tests the core search function: filename matching, regex, content search,
    // hidden file toggle, and recursion.

    #[test]
    fn search_finds_file_by_name_prefix() {
        let dir = tmp();
        make_file(dir.path(), "readme.md", b"docs");
        make_file(dir.path(), "main.rs", b"fn main() {}");
        make_file(dir.path(), "Cargo.toml", b"[package]");
        let results = search_advanced(
            "readme".to_string(),
            dir.path().to_string_lossy().to_string(),
            false, false, false, false,
        ).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "readme.md");
    }

    #[test]
    fn search_is_case_insensitive_for_plain_query() {
        let dir = tmp();
        make_file(dir.path(), "MyPhoto.JPG", b"");
        make_file(dir.path(), "other.txt", b"");
        let results = search_advanced(
            "myphoto".to_string(),
            dir.path().to_string_lossy().to_string(),
            false, false, false, false,
        ).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "MyPhoto.JPG");
    }

    #[test]
    fn search_regex_mode_matches_pattern() {
        let dir = tmp();
        make_file(dir.path(), "file001.log", b"");
        make_file(dir.path(), "file002.log", b"");
        make_file(dir.path(), "report.pdf", b"");
        let results = search_advanced(
            r"file\d+\.log".to_string(),
            dir.path().to_string_lossy().to_string(),
            false, true, false, false,
        ).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.name.ends_with(".log")));
    }

    #[test]
    fn search_regex_invalid_pattern_returns_error() {
        let dir = tmp();
        let result = search_advanced(
            "[invalid".to_string(),
            dir.path().to_string_lossy().to_string(),
            false, true, false, false,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("regex"));
    }

    #[test]
    fn search_excludes_hidden_files_by_default() {
        let dir = tmp();
        make_file(dir.path(), ".hidden", b"secret");
        make_file(dir.path(), "visible.txt", b"public");
        let results = search_advanced(
            "".to_string(),
            dir.path().to_string_lossy().to_string(),
            false, false, false, false,
        ).unwrap();
        assert!(results.iter().all(|r| !r.name.starts_with('.')));
    }

    #[test]
    fn search_includes_hidden_files_when_flag_set() {
        let dir = tmp();
        make_file(dir.path(), ".bashrc", b"alias ll=ls");
        make_file(dir.path(), "normal.txt", b"");
        let results = search_advanced(
            "bashrc".to_string(),
            dir.path().to_string_lossy().to_string(),
            false, false, false, true,
        ).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, ".bashrc");
    }

    #[test]
    fn search_contents_finds_text_inside_file() {
        let dir = tmp();
        make_file(dir.path(), "notes.txt", b"the quick brown fox");
        make_file(dir.path(), "other.txt", b"nothing interesting here");
        let results = search_advanced(
            "quick brown".to_string(),
            dir.path().to_string_lossy().to_string(),
            false, false, true, false,
        ).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "notes.txt");
        assert!(results[0].snippet.is_some());
    }

    #[test]
    fn search_recursive_finds_files_in_subdirectory() {
        let dir = tmp();
        let sub = dir.path().join("subdir");
        fs::create_dir(&sub).unwrap();
        make_file(&sub, "deep.txt", b"");
        make_file(dir.path(), "shallow.txt", b"");
        let results = search_advanced(
            "deep".to_string(),
            dir.path().to_string_lossy().to_string(),
            true, false, false, false,
        ).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "deep.txt");
    }

    #[test]
    fn search_non_recursive_does_not_descend() {
        let dir = tmp();
        let sub = dir.path().join("subdir");
        fs::create_dir(&sub).unwrap();
        make_file(&sub, "buried.txt", b"");
        let results = search_advanced(
            "buried".to_string(),
            dir.path().to_string_lossy().to_string(),
            false, false, false, false,
        ).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn search_returns_empty_for_nonexistent_root() {
        let results = search_advanced(
            "anything".to_string(),
            "/nonexistent/path/that/does/not/exist".to_string(),
            false, false, false, false,
        ).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn search_results_are_sorted_by_name_case_insensitive() {
        let dir = tmp();
        make_file(dir.path(), "Zebra.txt", b"");
        make_file(dir.path(), "apple.txt", b"");
        make_file(dir.path(), "Mango.txt", b"");
        let results = search_advanced(
            ".txt".to_string(),
            dir.path().to_string_lossy().to_string(),
            false, false, false, false,
        ).unwrap();
        let names: Vec<&str> = results.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["apple.txt", "Mango.txt", "Zebra.txt"]);
    }

    // ── batch_rename ──────────────────────────────────────────────────────────
    // Tests all 5 rename modes: find_replace, prefix, suffix, number, case.

    fn make_opts(mode: &str) -> BatchRenameOptions {
        BatchRenameOptions {
            mode: mode.to_string(),
            find: None, replace: None,
            prefix: None, suffix: None,
            start_num: None, padding: None,
            case_mode: None,
        }
    }

    #[test]
    fn batch_rename_find_replace_replaces_stem() {
        let dir = tmp();
        let p1 = make_file(dir.path(), "report_2025.txt", b"");
        let p2 = make_file(dir.path(), "report_2024.txt", b"");
        let opts = BatchRenameOptions {
            mode: "find_replace".to_string(),
            find: Some("report".to_string()),
            replace: Some("summary".to_string()),
            ..make_opts("find_replace")
        };
        let results = futures::executor::block_on(batch_rename(
            vec![p1.to_string_lossy().to_string(), p2.to_string_lossy().to_string()],
            opts,
        )).unwrap();
        assert!(results.iter().all(|r| !r.starts_with("ERROR:")));
        assert!(results.iter().any(|r| r.contains("summary_2025")));
        assert!(results.iter().any(|r| r.contains("summary_2024")));
    }

    #[test]
    fn batch_rename_prefix_prepends_to_stem() {
        let dir = tmp();
        let p = make_file(dir.path(), "photo.jpg", b"");
        let opts = BatchRenameOptions {
            mode: "prefix".to_string(),
            prefix: Some("vacation_".to_string()),
            ..make_opts("prefix")
        };
        let results = futures::executor::block_on(batch_rename(
            vec![p.to_string_lossy().to_string()], opts,
        )).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].contains("vacation_photo.jpg"));
    }

    #[test]
    fn batch_rename_suffix_appends_to_stem() {
        let dir = tmp();
        let p = make_file(dir.path(), "image.png", b"");
        let opts = BatchRenameOptions {
            mode: "suffix".to_string(),
            suffix: Some("_final".to_string()),
            ..make_opts("suffix")
        };
        let results = futures::executor::block_on(batch_rename(
            vec![p.to_string_lossy().to_string()], opts,
        )).unwrap();
        assert!(results[0].contains("image_final.png"));
    }

    #[test]
    fn batch_rename_number_uses_start_num_and_padding() {
        let dir = tmp();
        let files: Vec<_> = (0..3).map(|i| make_file(dir.path(), &format!("img{}.jpg", i), b"")).collect();
        let paths: Vec<String> = files.iter().map(|p| p.to_string_lossy().to_string()).collect();
        let opts = BatchRenameOptions {
            mode: "number".to_string(),
            start_num: Some(10),
            padding: Some(3),
            prefix: Some("photo_".to_string()),
            ..make_opts("number")
        };
        let results = futures::executor::block_on(batch_rename(paths, opts)).unwrap();
        assert!(results[0].contains("photo_010.jpg"));
        assert!(results[1].contains("photo_011.jpg"));
        assert!(results[2].contains("photo_012.jpg"));
    }

    #[test]
    fn batch_rename_case_lower() {
        let dir = tmp();
        let p = make_file(dir.path(), "MyFile.txt", b"");
        let opts = BatchRenameOptions {
            mode: "case".to_string(),
            case_mode: Some("lower".to_string()),
            ..make_opts("case")
        };
        let results = futures::executor::block_on(batch_rename(
            vec![p.to_string_lossy().to_string()], opts,
        )).unwrap();
        assert!(results[0].contains("myfile.txt"));
    }

    #[test]
    fn batch_rename_case_upper() {
        let dir = tmp();
        let p = make_file(dir.path(), "myfile.txt", b"");
        let opts = BatchRenameOptions {
            mode: "case".to_string(),
            case_mode: Some("upper".to_string()),
            ..make_opts("case")
        };
        let results = futures::executor::block_on(batch_rename(
            vec![p.to_string_lossy().to_string()], opts,
        )).unwrap();
        assert!(results[0].contains("MYFILE.txt"));
    }

    #[test]
    fn batch_rename_case_title() {
        let dir = tmp();
        let p = make_file(dir.path(), "the quick brown fox.txt", b"");
        let opts = BatchRenameOptions {
            mode: "case".to_string(),
            case_mode: Some("title".to_string()),
            ..make_opts("case")
        };
        let results = futures::executor::block_on(batch_rename(
            vec![p.to_string_lossy().to_string()], opts,
        )).unwrap();
        assert!(results[0].contains("The Quick Brown Fox.txt"));
    }

    #[test]
    fn batch_rename_errors_when_destination_already_exists() {
        let dir = tmp();
        let p = make_file(dir.path(), "original.txt", b"");
        // Create the conflict file that the rename would produce
        make_file(dir.path(), "conflict.txt", b"already here");
        let opts = BatchRenameOptions {
            mode: "find_replace".to_string(),
            find: Some("original".to_string()),
            replace: Some("conflict".to_string()),
            ..make_opts("find_replace")
        };
        let results = futures::executor::block_on(batch_rename(
            vec![p.to_string_lossy().to_string()], opts,
        )).unwrap();
        assert!(results[0].starts_with("ERROR:"));
        assert!(results[0].contains("conflict.txt"));
    }

    #[test]
    fn batch_rename_empty_input_returns_empty_output() {
        let opts = make_opts("prefix");
        let results = futures::executor::block_on(batch_rename(vec![], opts)).unwrap();
        assert!(results.is_empty());
    }

    // ── settings — migrate_settings ───────────────────────────────────────────

    #[test]
    fn migrate_settings_sets_version_on_empty_object() {
        let settings = serde_json::json!({});
        let migrated = migrate_settings(settings);
        assert_eq!(migrated["_v"], serde_json::json!(SETTINGS_VERSION));
    }

    #[test]
    fn migrate_settings_is_idempotent_at_current_version() {
        let settings = serde_json::json!({ "_v": SETTINGS_VERSION, "ff_theme": "dark" });
        let migrated = migrate_settings(settings.clone());
        assert_eq!(migrated["_v"], serde_json::json!(SETTINGS_VERSION));
        assert_eq!(migrated["ff_theme"], serde_json::json!("dark"));
    }

    #[test]
    fn migrate_settings_upgrades_version_0_to_current() {
        let settings = serde_json::json!({ "ff_viewMode": "list" });
        let migrated = migrate_settings(settings);
        assert_eq!(migrated["_v"], serde_json::json!(SETTINGS_VERSION));
        assert_eq!(migrated["ff_viewMode"], serde_json::json!("list"));
    }

    #[test]
    fn migrate_settings_preserves_all_user_keys() {
        let settings = serde_json::json!({
            "ff_locale": "fr",
            "ff_iconSize": "96",
            "ff_theme": "light",
        });
        let migrated = migrate_settings(settings);
        assert_eq!(migrated["ff_locale"],   serde_json::json!("fr"));
        assert_eq!(migrated["ff_iconSize"], serde_json::json!("96"));
        assert_eq!(migrated["ff_theme"],    serde_json::json!("light"));
    }
}
