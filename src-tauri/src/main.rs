#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json;
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
use std::sync::mpsc;
use std::time::Duration;

/// Holds the active directory watcher.
/// Replaced atomically on each watch_dir call; dropped (unwatched) on unwatch_dir.
struct DirWatcher {
    _watcher: RecommendedWatcher,
}
static ACTIVE_WATCHER: Mutex<Option<DirWatcher>> = Mutex::new(None);

static MEDIA_PORT: AtomicU16 = AtomicU16::new(0);
static EXTRACT_IN_PROGRESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
        return s;
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
            let b = st.f_frsize as u64;
            return (st.f_blocks as u64 * b, st.f_bavail as u64 * b);
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
    let last_seg=mountpoint.split('/').filter(|s|!s.is_empty()).last().unwrap_or("");
    if["cache","tmp","log","lost+found","proc","sys"].contains(&last_seg){return None;}
    // Always allow /run/media and /media (standard Linux USB mount points)
    if !device.starts_with('/')&&!device.starts_with("//"){return None;}
    let (total,free)=get_disk_space(mountpoint);
    // Skip zero-size pseudo mounts (but keep root)
    if total == 0 && mountpoint != "/" { return None; }
    let dev_short=device.split('/').last().unwrap_or(device);
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
        }
        // Only fall back to "usb" from mountpoint path if the device wasn't already
        // identified above (e.g. unknown device names under /run/media or /media)
        else if mountpoint.starts_with("/run/media")||mountpoint.starts_with("/media"){"usb"}
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
    let lock = DIR_CACHE.read().unwrap();
    lock.as_ref()?.get(path).cloned()
}

fn cache_insert(path: String, entries: Vec<FileEntryFast>) {
    // Write lock — exclusive, brief.
    let mut lock = DIR_CACHE.write().unwrap();
    let cache = lock.get_or_insert_with(DirCache::new);
    cache.insert(path, entries);
}

fn cache_evict(path: &str) {
    let mut lock = DIR_CACHE.write().unwrap();
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
                    if rm || disk_tran == "usb" || part_name.starts_with("sd") && is_usb_device(part_name.split('/').last().unwrap_or(part_name)) {
                        "usb"
                    } else if disk_tran == "nvme" || part_name.starts_with("nvme") || disk_name.starts_with("nvme") {
                        "nvme"
                    } else if is_rotational(disk_name.split('/').last().unwrap_or(disk_name)) {
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
    let raw_favs=vec![
        ("Home",home.to_string_lossy().to_string(),"home"),
        ("Desktop",home.join("Desktop").to_string_lossy().to_string(),"folder"),
        ("Documents",home.join("Documents").to_string_lossy().to_string(),"doc"),
        ("Downloads",home.join("Downloads").to_string_lossy().to_string(),"download"),
        ("Pictures",home.join("Pictures").to_string_lossy().to_string(),"img"),
        ("Music",home.join("Music").to_string_lossy().to_string(),"music"),
        ("Videos",home.join("Videos").to_string_lossy().to_string(),"video"),
        ("Trash",trash_path.to_string_lossy().to_string(),"trash"),
    ];
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
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
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
        if !raw.is_empty() && raw[..raw.len().min(4096)].iter().any(|&b|b==0) { return Ok(FilePreview{path,content:None,image_base64:None,mime_type:"application/octet-stream".into(),size,modified,is_text:false,is_image:false,is_video:false,is_audio:false,line_count:None,permissions,thumb_path:None}); }
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
                if modified<cutoff{
                    if fs::remove_file(&path).is_ok(){deleted+=1;}
                }
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
                    let t = tag_buf.trim_start_matches('/').trim().split_whitespace().next().unwrap_or("").to_lowercase();
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
                let t = tag_buf.trim_start_matches('/').trim().split_whitespace().next().unwrap_or("").to_lowercase();
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
            format!("[Trash Info]\nPath={}\nDeletionDate={}\n",abs_path.display(),ts));
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

/// Securely delete a file by overwriting with random data before deletion.
/// Emits "secure-delete-progress": {path, done, total, finished, error?}
#[tauri::command]
async fn secure_delete(window: tauri::Window, paths: Vec<String>, passes: u32) -> Result<(), String> {
    use rand::Rng;
    
    let total = paths.len() as u64;
    let _ = window.emit("secure-delete-progress", serde_json::json!({"done":0,"total":total,"finished":false}));
    
    for (idx, path) in paths.iter().enumerate() {
        let path_clone = path.clone();
        
        let _ = window.emit("secure-delete-progress", serde_json::json!({"path":path,"done":idx as u64,"total":total,"finished":false}));
        
        if let Err(e) = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let p = Path::new(&path_clone);
            if !p.exists() { return Ok(()); }
            
            if p.is_dir() {
                return Err("secure_delete does not support directories".into());
            }
            
            let metadata = fs::metadata(p).map_err(|e|e.to_string())?;
            let size = metadata.len() as usize;
            
            // Overwrite with random data
            for _ in 0..passes {
                let mut file = fs::OpenOptions::new().write(true).open(p).map_err(|e|e.to_string())?;
                let mut rng = rand::thread_rng();
                let mut buffer = vec![0u8; size.min(65536)];
                
                let mut written = 0;
                while written < size {
                    let chunk_size = (size - written).min(buffer.len());
                    rng.fill(&mut buffer[..chunk_size]);
                    file.write_all(&buffer[..chunk_size]).map_err(|e|e.to_string())?;
                    written += chunk_size;
                }
                file.sync_all().map_err(|e|e.to_string())?;
            }
            
            // Finally delete the file
            fs::remove_file(p).map_err(|e|e.to_string())?;
            Ok(())
        }).await {
            let _ = window.emit("secure-delete-progress", serde_json::json!({"path":path,"done":idx as u64,"total":total,"finished":false,"error":e.to_string()}));
        }
    }
    
    let _ = window.emit("secure-delete-progress", serde_json::json!({"done":total,"total":total,"finished":true}));
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
            let _=fs::write(ti.join(format!("{}.trashinfo",&dn)),format!("[Trash Info]\nPath={}\nDeletionDate={}\n",abs.display(),ts));
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
}

#[tauri::command]
fn copy_files_batch(window: Window, srcs: Vec<String>, dest_dir: String) {
    let dest_dir = dest_dir.clone();
    std::thread::spawn(move || {
        let total = srcs.len();
        for (i, src) in srcs.iter().enumerate() {
            let name = Path::new(src).file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let result = copy_file_sync(src.clone(), dest_dir.clone());
            let _ = window.emit("file-op-progress", FileOpProgress {
                done: i + 1, total,
                name: name.clone(),
                error: result.err(),
                finished: if i + 1 == total { Some(true) } else { None },
            });
        }
    });
}

#[tauri::command]
fn move_files_batch(window: Window, srcs: Vec<String>, dest_dir: String) {
    let dest_dir = dest_dir.clone();
    std::thread::spawn(move || {
        let total = srcs.len();
        for (i, src) in srcs.iter().enumerate() {
            let name = Path::new(src).file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let result = move_file_sync(src.clone(), dest_dir.clone());
            let _ = window.emit("file-op-progress", FileOpProgress {
                done: i + 1, total,
                name: name.clone(),
                error: result.err(),
                finished: if i + 1 == total { Some(true) } else { None },
            });
        }
    });
}

// ── Compression ───────────────────────────────────────────────────────────────

#[tauri::command]
async fn compress_files(window: tauri::Window, paths:Vec<String>,output_path:String)->Result<CompressResult,String> {
    tauri::async_runtime::spawn_blocking(move || _compress_files_sync(window, paths, output_path))
        .await
        .map_err(|e| format!("thread error: {}", e))?
}

fn _compress_files_sync(window: tauri::Window, paths:Vec<String>,output_path:String)->Result<CompressResult,String> {
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
    let options=FileOptions::<()>::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);
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

fn _extract_archive_sync(window: tauri::Window, archive_path:String,dest_dir:String)->Result<usize,String> {
    use zip::ZipArchive;

    fs::create_dir_all(&dest_dir).map_err(|e|e.to_string())?;

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
            // Sanitize: strip ".." components to prevent path traversal
            let name=file.name().replace("..","_").replace('\\',"/");
            let outpath=Path::new(&dest_dir).join(&name);
            if name.ends_with('/'){
                fs::create_dir_all(&outpath).map_err(|e|e.to_string())?;
            }else{
                if let Some(p)=outpath.parent(){fs::create_dir_all(p).map_err(|e|e.to_string())?;}
                let mut outfile=fs::File::create(&outpath).map_err(|e|e.to_string())?;
                std::io::copy(&mut file, &mut outfile).map_err(|e|e.to_string())?;
            }
            // Emit every 8 entries to keep IPC traffic low on large archives
            if i % 8 == 7 || i == count - 1 {
                let _ = window.emit("extract-progress", serde_json::json!({
                    "done": i + 1, "total": count, "finished": false, "name": &name
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

fn start_media_server()->u16 {
    use std::net::TcpListener;
    let listener=TcpListener::bind("127.0.0.1:0").expect("media server bind");
    let port=listener.local_addr().unwrap().port();
    MEDIA_PORT.store(port,Ordering::Relaxed);
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
    let mut reader=BufReader::new(stream.try_clone().unwrap());
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

#[tauri::command]
fn mpv_play(_path: String, _backend: String, _handle: i64,
    _margin_left: f64, _margin_top: f64, _margin_right: f64, _margin_bottom: f64,
) -> Result<(), String> { Ok(()) }

#[tauri::command]
fn mpv_stop() -> Result<(), String> {
    let mut lock = mpv_child().lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = lock.take() { child.kill().ok(); child.wait().ok(); }
    Ok(())
}

#[tauri::command]
fn mpv_update_margins(_ml: f64, _mt: f64, _mr: f64, _mb: f64) -> Result<(), String> { Ok(()) }

#[tauri::command]
fn mpv_pause_toggle() -> Result<(), String> { Ok(()) }


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
        return Err(String::from_utf8_lossy(&r.stderr).trim().to_string());
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
                iso_path.split('/').last().unwrap_or("ISO"),
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

            for line in reader.lines().filter_map(|l| l.ok()) {
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

// watch_dir: watch one or more paths with the OS notify backend (inotify on Linux).
// Emits "dir-changed" with the specific changed directory path — only when the
// LISTING changes: new file, deleted file, or rename/move.
// Content writes (Modify::Data) are intentionally ignored.
// Multiple paths are supported so all open columns are watched simultaneously.
// Debounced: rapid bursts within 300ms coalesce into single events per directory.
#[tauri::command]
fn watch_dir(window: Window, paths: Vec<String>) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<String>();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                use notify::EventKind::*;
                use notify::event::ModifyKind;
                let should_emit = match event.kind {
                    // A file or directory was created or deleted — listing changed.
                    Create(_) | Remove(_) => true,
                    // Rename / move: fires as Modify(Name(_)) in notify v6 on Linux.
                    // This is the event that fires when a browser download completes:
                    //   video.mp4.crdownload  →  video.mp4
                    // We must not drop it, because this IS a listing change.
                    Modify(ModifyKind::Name(_)) => true,
                    // Content writes (Modify::Data) fire on every write to a file.
                    // A content write does NOT change what files exist in the directory.
                    Modify(_) => false,
                    _ => false,
                };
                if should_emit {
                    // Derive the parent directory from the affected file path.
                    // This is always valid: notify events for NonRecursive watchers
                    // only fire for direct children of the watched directory.
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

    // Debounce thread: coalesce rapid bursts into one "dir-changed" per directory.
    // Collects all changed paths within a 300ms window, then emits each once.
    let emit_window = window.clone();
    std::thread::spawn(move || {
        loop {
            // Block until at least one event arrives
            let first = match rx.recv() {
                Ok(p) => p,
                Err(_) => break,
            };
            let mut changed = std::collections::HashSet::new();
            changed.insert(first);
            // Drain any burst within the debounce window
            let deadline = std::time::Instant::now() + Duration::from_millis(300);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() { break; }
                match rx.recv_timeout(remaining) {
                    Ok(p) => { changed.insert(p); }
                    Err(_) => break,
                }
            }
            // One coalesced emit per unique changed directory
            for dir in changed {
                let _ = emit_window.emit("dir-changed", &dir);
            }
        }
    });

    *ACTIVE_WATCHER.lock().unwrap() = Some(DirWatcher { _watcher: watcher });
    Ok(())
}

/// Stop watching. Called on navigate-away or app teardown.
#[tauri::command]
fn unwatch_dir() {
    *ACTIVE_WATCHER.lock().unwrap() = None;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            list_directory, list_directory_fast, list_directory_streamed, list_directory_chunk, list_directory_full_streamed, get_entry_meta, preload_dir,
            get_home_dir, get_sidebar_data, get_drives,
            open_file, get_file_preview, search_files,
            rename_file, delete_file, delete_items_stream, create_directory, create_file_cmd, get_dir_size,
            window_minimize, window_maximize, window_close, window_set_fullscreen, window_is_maximized,
            copy_file, move_file, copy_files_batch, move_files_batch, create_new_document,
            get_media_port, get_thumbnail, get_thumbnail_bytes, get_thumbnail_bytes_batch,
            batch_thumbnails, get_thumbnail_url_batch, gc_thumbnail_cache, empty_trash,
            open_as_root, check_permission, read_svg_icon, eject_drive, mount_drive, unlock_and_mount_encrypted,
            get_file_tags, set_file_tags, get_all_tags, search_by_tag,
            get_tag_palette, set_tag_color, get_tags_with_colors, deep_search,
            compress_files, extract_archive, delete_items,
            empty_trash_stream,
            open_terminal, open_in_editor,
            list_apps_for_file, open_with_app,
            get_native_window_handle, mpv_open_external, mpv_is_running, mpv_play, mpv_stop, mpv_update_margins, mpv_pause_toggle,
            set_ql_payload, get_ql_payload,
            watch_dir, unwatch_dir,
            mount_iso, unmount_iso, get_iso_loop_device, list_usb_drives, write_iso_to_usb,
            mount_dmg, unmount_dmg, get_dmg_loop_device,
            install_font, is_font_installed,
            secure_delete, find_duplicates,
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
                            if fs::create_dir_all(&dir).is_ok() {
                                if fs::write(&dest, icon.data).is_ok() {
                                    any_written = true;
                                }
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


