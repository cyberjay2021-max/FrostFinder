// ============================================================
// utils.js — Constants, formatters, icons, icon theme system
// ============================================================

// ── SVG Icon Library ─────────────────────────────────────────────────────────
export const I = {
  home:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  monitor:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  doc:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  pdf:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/><line x1="14" y1="9" x2="16" y2="9"/></svg>`,
  download:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  img:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  music:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  video:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
  hd:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="10" ry="6"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M2 12c0 3.31 4.48 6 10 6s10-2.69 10-6"/></svg>`,
  nvme:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 11h2M10 11h2M14 11h2"/><circle cx="19" cy="11" r="1" fill="currentColor"/></svg>`,
  ssd:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><rect x="5" y="9" width="10" height="6" rx="1"/><path d="M17 9v6"/></svg>`,
  usb:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4M12 2v8M8 14l4 4 4-4M12 18v4M7 10h10a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2z"/></svg>`,
  network:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  optical:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>`,
  folder:`<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`,
  folderSym:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/><path d="M12 13l2 2-2 2M14 15H9"/></svg>`,
  file:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
  code:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  zip:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
  trash:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  chev:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  back:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  fwd:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
  search:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  eye:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  iconView:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  listView:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="18" r="1" fill="currentColor" stroke="none"/></svg>`,
  colView:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="18" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>`,
  galleryView:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="13" rx="2"/><rect x="5" y="19" width="4" height="2" rx="1"/><rect x="10" y="19" width="4" height="2" rx="1"/><rect x="15" y="19" width="4" height="2" rx="1"/></svg>`,
  openExt:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  x:`<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`,
  plus:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  folderPlus:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`,
  filePlus:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
  copy:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  scissors:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
  paste:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>`,
  edit:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  terminal:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  tag:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  compress:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  extract:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  // ISO disc icon — concentric circles representing a disc/CD-ROM
  disc:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  mount:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 5 17 10"/><line x1="12" y1="5" x2="12" y2="17"/></svg>`,
  unmount:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="12" y1="4" x2="12" y2="14"/></svg>`,
  burn:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c0 6-8 7-8 13a8 8 0 0 0 16 0c0-6-8-7-8-13z"/><path d="M12 12c0 3-3 4-3 6a3 3 0 0 0 6 0c0-2-3-3-3-6z" fill="currentColor" opacity=".35" stroke="none"/></svg>`,
  star:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  starFilled:`<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
};

// ── File type constants ───────────────────────────────────────────────────────
export const IMAGE_EXTS  = ['png','jpg','jpeg','gif','webp','bmp','svg','ico','tiff','tif','heic','heif','xcf'];
export const VIDEO_EXTS  = ['mp4','mkv','webm','avi','mov','ogv','m4v'];
export const AUDIO_EXTS  = ['mp3','flac','ogg','wav','aac','m4a','opus','weba'];
export const DOC_EXTS    = ['md','txt','rs','js','ts','py','go','c','cpp','h','toml','json','yaml','yml','xml','css','sh','log','csv','rtf'];
export const OFFICE_EXTS = ['doc','docx','xls','xlsx'];  // Office Open XML — text extracted in Rust
export const BOOK_EXTS   = ['epub','mobi','azw','azw3']; // E-books — text extracted in Rust
export const HTML_EXTS   = ['html','htm'];
export const PDF_EXTS    = ['pdf'];
export const ARCHIVE_EXTS= ['zip','tar','gz','7z','rar','bz2','xz','zst','tar.gz','tar.bz2','tar.xz','tar.zst','tgz','tbz2','txz'];
export const ISO_EXTS    = ['iso'];
export const DMG_EXTS    = ['dmg'];
export const FONT_EXTS   = ['otf','ttf','woff','woff2'];

// Tag color palette
export const TAG_COLORS = {
  red:'#f87171',orange:'#fb923c',yellow:'#fbbf24',green:'#34d399',
  blue:'#60a5fa',purple:'#a78bfa',pink:'#f472b6',gray:'#94a3b8',
};

// ── Formatters ────────────────────────────────────────────────────────────────
export const fmtSize = b => !b?'--':b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':b<1073741824?(b/1048576).toFixed(1)+'MB':(b/1073741824).toFixed(1)+'GB';
export const fmtDate = ts => !ts?'--':new Date(ts*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
export const escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

export function fileColor(e) {
  if(e.is_dir) return '#5b8dd9';
  const x=e.extension||'';
  if(IMAGE_EXTS.includes(x))  return x==='xcf'?'#34d399':'#a78bfa';  // xcf=green (GIMP), others=purple
  if(VIDEO_EXTS.includes(x))  return '#f87171';
  if(AUDIO_EXTS.includes(x))  return '#f472b6';
  if(['md','txt','log','rtf'].includes(x)) return '#94a3b8';
  if(['doc','docx'].includes(x))           return '#5b8dd9'; // Word — blue
  if(['xls','xlsx'].includes(x))           return '#34d399'; // Excel — green (kept consistent with csv)
  if(BOOK_EXTS.includes(x))               return '#fb923c'; // ebooks — orange
  if(['rs','js','ts','py','go','c','cpp','h'].includes(x)) return '#fb923c';
  if(['toml','json','yaml','yml','plist','xml'].includes(x)) return '#fbbf24';
  if(ARCHIVE_EXTS.includes(x)) return '#c4b5fd';
  if(PDF_EXTS.includes(x))    return '#f87171';
  if(ISO_EXTS.includes(x))    return '#f472b6'; // pink — disc/optical
  if(DMG_EXTS.includes(x))    return '#f472b6'; // pink — disc/apple
  if(FONT_EXTS.includes(x))   return '#fb923c'; // orange — fonts
  if(['csv'].includes(x))      return '#34d399';
  return '#636368';
}

export function mimeLabel(m){
  return({'image/png':'PNG Image','image/jpeg':'JPEG Image','image/gif':'GIF','image/webp':'WebP','image/svg+xml':'SVG','image/bmp':'BMP',
    'image/x-xcf':'GIMP Image','image/tiff':'TIFF Image',
    'video/mp4':'MP4 Video','video/x-matroska':'MKV Video','video/webm':'WebM Video','video/x-msvideo':'AVI Video','video/quicktime':'MOV Video',
    'audio/mpeg':'MP3 Audio','audio/flac':'FLAC Audio','audio/ogg':'OGG Audio','audio/wav':'WAV Audio','audio/aac':'AAC Audio','audio/mp4':'M4A Audio','audio/opus':'Opus Audio',
    'application/pdf':'PDF','application/json':'JSON','text/plain':'Text','text/markdown':'Markdown',
    'application/rtf':'RTF Document',
    'application/msword':'Word Document',
    'application/vnd.ms-excel':'Excel Spreadsheet',
    'application/epub+zip':'ePub Book',
    'application/x-mobipocket-ebook':'Mobipocket Book',
    'text/html':'HTML Document',
    'application/x-iso9660-image':'ISO Disc Image',
    'application/x-apple-diskimage':'Apple Disk Image',
    'font/otf':'OpenType Font','font/ttf':'TrueType Font','font/woff':'WOFF Font','font/woff2':'WOFF2 Font',
    'text/x-rust':'Rust','text/x-python':'Python','text/javascript':'JS','text/css':'CSS','application/octet-stream':'Binary'})[m]||m;
}

export function fmtDriveSpace(d){
  if(!d.total_bytes)return'';
  const u=d.total_bytes-d.free_bytes,p=Math.round(u/d.total_bytes*100);
  return`${fmtSize(u)} of ${fmtSize(d.total_bytes)} (${p}%)`;
}

// ── Icon Theme System ─────────────────────────────────────────────────────────
// Bundled theme JS (KORA, WHITESUR, NEWAITA) removed in r11 — they added ~375 KB
// to the cold-start parse budget. Only the built-in SVG set is synchronous.
// The theme-picker UI still exists so users aren't confused; it simply shows
// "Built-in" as the only option until additional themes are added via disk load.
const ICON_THEMES = {
  builtin: {name:'Built-in', path:null},
};

// ── localStorage migration: reset any stored theme key that is no longer valid
const _REMOVED_BUNDLED_THEMES = new Set(['kora','whitesur','whitesur_dark','whitesur_light','newaita']);


let _iconTheme = localStorage.getItem('ff_iconTheme')||'builtin';
// Migrate any stored bundled-theme key that no longer exists back to builtin.
if (_REMOVED_BUNDLED_THEMES.has(_iconTheme) || !ICON_THEMES[_iconTheme]) {
  _iconTheme = 'builtin';
  localStorage.setItem('ff_iconTheme','builtin');
}

let _renderCallback = null;
export function setRenderCallback(fn){ _renderCallback=fn; }

export function setIconTheme(themeKey){
  if (!ICON_THEMES[themeKey]) themeKey = 'builtin';
  _iconTheme = themeKey;
  localStorage.setItem('ff_iconTheme', themeKey);
  _renderCallback?.();
}

export function getIcon(key){
  // builtin — always synchronous, zero IPC, zero parse cost
  return I[key]||I.file;
}

export function fileIcon(e){
  if(e.is_symlink&&e.is_dir) return I.folderSym;
  if(e.is_dir) return getIcon('folder');
  // file types below
  const x=e.extension||'';
  if(IMAGE_EXTS.includes(x))  return getIcon('img');
  if(AUDIO_EXTS.includes(x))  return getIcon('music');
  if(VIDEO_EXTS.includes(x))  return getIcon('video');
  if(PDF_EXTS.includes(x))    return getIcon('pdf');
  if(['doc','docx'].includes(x)) return getIcon('doc');
  if(['xls','xlsx'].includes(x)) return getIcon('doc');
  if(BOOK_EXTS.includes(x))    return getIcon('doc'); // ebooks
  if(['rs','js','ts','py','go','c','cpp','h'].includes(x)) return getIcon('code');
  if(ARCHIVE_EXTS.includes(x)) return getIcon('zip');
  if(ISO_EXTS.includes(x))    return getIcon('disc');
  if(DMG_EXTS.includes(x))    return getIcon('disc');
  if(FONT_EXTS.includes(x))   return getIcon('doc');
  if(HTML_EXTS.includes(x))   return getIcon('doc');
  if(['md','txt','toml','json','yaml','plist','xml','log','csv','rtf'].includes(x)) return getIcon('doc');
  return getIcon('file');
}

export function driveIcon(d){
  const icons={
    usb:    getIcon('usb'),
    network:getIcon('network'),
    optical:getIcon('optical'),
    nvme:   getIcon('nvme'),
    ssd:    getIcon('ssd'),
    hdd:    getIcon('hd'),
  };
  return icons[d.drive_type]||getIcon('hd');
}
export function driveColor(d){
  return{
    usb:    '#34d399', // green
    network:'#60a5fa', // blue
    optical:'#f472b6', // pink
    nvme:   '#a78bfa', // purple
    ssd:    '#60a5fa', // blue
    hdd:    '#94a3b8', // grey
    internal:'#94a3b8',
  }[d.drive_type]||'#94a3b8';
}
export function driveTypeBadge(d){
  return{
    usb:    'USB',
    network:'NET',
    optical:'OPT',
    nvme:   'NVMe',
    ssd:    'SSD',
    hdd:    'HDD',
  }[d.drive_type]||'';
}

export function favIcon(ic){
  const m={home:'home',monitor:'monitor',doc:'doc',download:'download',img:'img',music:'music',video:'video',folder:'folder',trash:'trash'};
  return getIcon(m[ic]||'folder');
}
export function favColor(ic){return{home:'#60a5fa',monitor:'#94a3b8',doc:'#e2e8f0',download:'#34d399',img:'#a78bfa',music:'#f472b6',video:'#f87171',trash:'#636368'}[ic]||'#94a3b8';}

export function showIconThemePicker(){
  const existing=document.getElementById('icon-theme-dialog');
  if(existing){existing.remove();return;}
  const d=document.createElement('div');
  d.id='icon-theme-dialog';
  d.style.cssText='position:fixed;top:90px;right:16px;z-index:5000;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px;min-width:220px;box-shadow:0 8px 32px rgba(0,0,0,.6);';
  const themes=Object.entries(ICON_THEMES).map(([key,t])=>({key,name:t.name}));
  d.innerHTML='<div style="font-size:11px;font-weight:600;color:#98989f;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">Icon Theme</div>'
    +themes.map(t=>`<div class="icon-theme-opt${t.key===_iconTheme?' active':''}" data-key="${t.key}" style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:7px;cursor:pointer;margin-bottom:2px;${t.key===_iconTheme?'background:var(--accent-blue);color:#fff;':'color:var(--text-primary);'}"><span style="font-size:13px">${t.name}</span>${t.key===_iconTheme?'<span style="margin-left:auto;font-size:11px">✓</span>':''}</div>`).join('');
  document.body.appendChild(d);
  d.querySelectorAll('.icon-theme-opt').forEach(el=>{
    el.addEventListener('click',()=>{d.remove();setIconTheme(el.dataset.key);});
  });
  setTimeout(()=>document.addEventListener('mousedown',function h(e){if(!e.target.closest('#icon-theme-dialog')){d.remove();document.removeEventListener('mousedown',h);}}),0);
}

// ── Bookmarks System ────────────────────────────────────────────────────────────
const BOOKMARKS_KEY = 'ff_bookmarks';

export function getBookmarks(){
  try{ return JSON.parse(localStorage.getItem(BOOKMARKS_KEY)||'[]'); }
  catch{ return []; }
}

export function saveBookmarks(bookmarks){
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
}

export function addBookmark(path, name){
  const bookmarks = getBookmarks();
  if(!bookmarks.some(b=>b.path===path)){
    bookmarks.push({path, name:name||path.split('/').pop()});
    saveBookmarks(bookmarks);
  }
  return bookmarks;
}

export function removeBookmark(path){
  const bookmarks = getBookmarks().filter(b=>b.path!==path);
  saveBookmarks(bookmarks);
  return bookmarks;
}

export function isBookmarked(path){
  return getBookmarks().some(b=>b.path===path);
}
