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
  server:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`,
  cloud:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
};

// ── File type constants ───────────────────────────────────────────────────────
export const IMAGE_EXTS  = ['png','jpg','jpeg','gif','webp','bmp','svg','ico','tiff','tif','heic','heif','xcf'];
export const VIDEO_EXTS  = ['mp4','mkv','webm','avi','mov','ogv','m4v','flv','wmv','3gp'];
export const AUDIO_EXTS  = ['mp3','flac','ogg','wav','aac','m4a','opus','weba'];
// TEXT_EXTS: files the inline editor can open (read_text_file + CodeMirror)
export const TEXT_EXTS   = ['txt','md','rs','js','ts','jsx','tsx','py','go','c','cpp','h','hpp','cs','java','rb','php','swift','kt','toml','json','yaml','yml','xml','css','scss','less','sh','bash','zsh','fish','env','conf','cfg','ini','log','csv','lock','gitignore','dockerfile','svg','sql','lua','r','vim','el','html','htm'];
export const DOC_EXTS    = [...TEXT_EXTS, 'rtf'];
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
// Date locale is set by initI18n() via setDateLocale() after the language is resolved.
let _dateLocale = 'en-US';
export function setDateLocale(lang) { _dateLocale = lang || 'en-US'; }
// p8: smart relative timestamps
// Today → "Today, 2:34 PM" | This week → "Tuesday" | This year → "Mar 21"
// Older → "Mar 21, 2025" | hover title always shows full absolute time
export function fmtDate(ts) {
  if (!ts) return '--';
  const d   = new Date(ts * 1000);
  const now = new Date();
  const diffMs  = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffH   = Math.floor(diffMs / 3600000);
  const isToday = d.toDateString() === now.toDateString();
  const isThisWeek = diffMs < 7 * 86400000 && d <= now;
  const isThisYear = d.getFullYear() === now.getFullYear();
  if (diffMin < 1)     return 'Just now';
  if (diffMin < 60)    return diffMin + ' min ago';
  if (isToday)         return 'Today, ' + d.toLocaleTimeString(_dateLocale, {hour:'2-digit', minute:'2-digit'});
  if (isThisWeek)      return d.toLocaleDateString(_dateLocale, {weekday:'long'});
  if (isThisYear)      return d.toLocaleDateString(_dateLocale, {month:'short', day:'numeric'});
  return d.toLocaleDateString(_dateLocale, {month:'short', day:'numeric', year:'numeric'});
}
// Absolute timestamp for tooltip use
export function fmtDateAbsolute(ts) {
  if (!ts) return '--';
  return new Date(ts * 1000).toLocaleString(_dateLocale, {
    month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit'
  });
}
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
// ── Icon Theme System ─────────────────────────────────────────────────────────
// Supports the built-in SVG set plus user-supplied disk themes.
// A disk theme is a folder of .svg files whose basenames match icon keys
// (e.g. folder.svg, file.svg, img.svg …). Any unrecognised keys fall back
// to the built-in set so partial themes work out of the box.
//
// Stored state:
//   ff_iconTheme   — 'builtin' | 'disk:<folderPath>'
//   ff_diskThemeSvgs — JSON: { [key]: <svg …/> }  (cached from last load)

const _BUILTIN_THEME_KEY = 'builtin';
const _REMOVED_BUNDLED_THEMES = new Set(['kora','whitesur','whitesur_dark','whitesur_light','newaita']);

// In-memory SVG override map for disk themes  { key → svg string }
let _diskIcons = {};

let _iconTheme = localStorage.getItem('ff_iconTheme') || _BUILTIN_THEME_KEY;
if (_REMOVED_BUNDLED_THEMES.has(_iconTheme)) {
  _iconTheme = _BUILTIN_THEME_KEY;
  localStorage.setItem('ff_iconTheme', _BUILTIN_THEME_KEY);
}

// Restore cached disk theme SVGs from localStorage so icons load synchronously
// without waiting for the Rust IPC scan on every launch.
if (_iconTheme.startsWith('disk:')) {
  try {
    const cached = localStorage.getItem('ff_diskThemeSvgs');
    if (cached) _diskIcons = JSON.parse(cached);
  } catch (_) { _diskIcons = {}; }
}

let _renderCallback = null;
export function setRenderCallback(fn){ _renderCallback=fn; }

/**
 * Switch to a named theme.
 * themeKey: 'builtin' | 'disk:<absoluteFolderPath>'
 * svgMap (optional): pre-loaded { key→svg } map for disk themes.
 */
export function setIconTheme(themeKey, svgMap = null) {
  if (!themeKey || (_REMOVED_BUNDLED_THEMES.has(themeKey))) themeKey = _BUILTIN_THEME_KEY;
  _iconTheme = themeKey;
  localStorage.setItem('ff_iconTheme', themeKey);
  if (themeKey === _BUILTIN_THEME_KEY) {
    _diskIcons = {};
    localStorage.removeItem('ff_diskThemeSvgs');
  } else if (svgMap) {
    _diskIcons = svgMap;
    localStorage.setItem('ff_diskThemeSvgs', JSON.stringify(svgMap));
  }
  _renderCallback?.();
}

export function getIcon(key){
  // Disk theme overrides first; fall back to built-in set
  if (_diskIcons[key]) return _diskIcons[key];
  return I[key] || I.file;
}

/**
 * Load a disk theme from folderPath.
 * Reads the cached SVG list from localStorage if available,
 * then triggers a fresh scan via Tauri IPC and updates if anything changed.
 * Returns { loaded: number, skipped: number } for UI feedback.
 */
export async function loadDiskTheme(folderPath) {
  if (typeof window === 'undefined') return { loaded: 0, skipped: 0 };
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // scan_icon_folder returns [{ key, svg }] for matched icons
    const hits = await invoke('scan_icon_folder', { folderPath });
    if (!hits || !hits.length) return { loaded: 0, skipped: 0 };
    const svgMap = {};
    for (const { key, svg } of hits) { svgMap[key] = svg; }
    setIconTheme('disk:' + folderPath, svgMap);
    return { loaded: hits.length, skipped: 0 };
  } catch (err) {
    console.warn('loadDiskTheme error:', err);
    return { loaded: 0, skipped: 0, error: String(err) };
  }
}

export function getCurrentThemeName() {
  if (_iconTheme === _BUILTIN_THEME_KEY) return 'Built-in';
  if (_iconTheme.startsWith('disk:')) {
    const folder = _iconTheme.slice(5);
    return folder.split('/').pop() || folder;
  }
  return _iconTheme;
}

export function isUsingDiskTheme() {
  return _iconTheme.startsWith('disk:');
}

export function getCurrentThemePath() {
  return _iconTheme.startsWith('disk:') ? _iconTheme.slice(5) : null;
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
  d.style.cssText='position:fixed;top:90px;right:16px;z-index:5000;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px;min-width:240px;box-shadow:0 8px 32px rgba(0,0,0,.6);';

  const usingDisk = isUsingDiskTheme();
  const diskName  = usingDisk ? getCurrentThemeName() : null;
  const diskPath  = usingDisk ? getCurrentThemePath() : null;
  const diskCount = usingDisk ? Object.keys(_diskIcons).length : 0;

  d.innerHTML =
    '<div style="font-size:11px;font-weight:600;color:#98989f;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">Icon Theme</div>' +
    // Built-in option
    `<div class="icon-theme-opt${!usingDisk?' active':''}" id="itt-builtin" style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:7px;cursor:pointer;margin-bottom:2px;${!usingDisk?'background:var(--accent-blue);color:#fff;':'color:var(--text-primary);'}">` +
      '<span style="font-size:13px">Built-in</span>' +
      (!usingDisk?'<span style="margin-left:auto;font-size:11px">✓</span>':'') +
    '</div>' +
    // Current disk theme (if loaded) — with remove button
    (usingDisk ? `<div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;">` +
      `<div class="icon-theme-opt active" id="itt-disk" style="display:flex;align-items:center;gap:8px;flex:1;padding:7px 10px;border-radius:7px;cursor:default;background:var(--accent-blue,#5b8dd9);color:#fff;">` +
        `<span style="font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${diskPath}">${diskName}</span>` +
        `<span style="font-size:10px;opacity:.75">${diskCount} icons</span>` +
        '<span style="margin-left:4px;font-size:11px">✓</span>' +
      '</div>' +
      `<button id="itt-remove" title="Remove this theme" style="flex-shrink:0;width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.25);border-radius:7px;cursor:pointer;font-size:13px;transition:background .12s;">✕</button>` +
    '</div>' : '') +
    // Separator + load button
    '<div style="border-top:1px solid rgba(255,255,255,.07);margin:8px 0 6px"></div>' +
    '<button id="itt-load" style="width:100%;padding:7px 10px;background:rgba(91,141,217,.12);color:#5b8dd9;border:1px solid rgba(91,141,217,.25);border-radius:7px;font-size:12px;cursor:pointer;text-align:left">📂 Load from folder…</button>' +
    (usingDisk ? '<button id="itt-reload" style="width:100%;margin-top:4px;padding:6px 10px;background:rgba(255,255,255,.04);color:var(--text-secondary,#94a3b8);border:1px solid rgba(255,255,255,.08);border-radius:7px;font-size:11px;cursor:pointer;text-align:left">↻ Reload current theme</button>' : '') +
    '<div id="itt-status" style="font-size:11px;color:#94a3b8;margin-top:6px;min-height:16px"></div>';

  document.body.appendChild(d);

  const status = d.querySelector('#itt-status');

  // Built-in option click
  d.querySelector('#itt-builtin')?.addEventListener('click', () => {
    setIconTheme('builtin');
    d.remove();
  });

  // Load from folder button
  d.querySelector('#itt-load')?.addEventListener('click', async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const folder = await open({ directory: true, title: 'Choose icon theme folder' });
      if (!folder) return;
      if (status) status.textContent = 'Scanning…';
      const result = await loadDiskTheme(folder);
      if (result.error) {
        if (status) status.textContent = 'Error: ' + result.error;
        return;
      }
      if (result.loaded === 0) {
        if (status) { status.style.color='#f87171'; status.textContent = 'No matching icons found in that folder.'; }
        return;
      }
      if (status) { status.style.color='#34d399'; status.textContent = `Loaded ${result.loaded} icons.`; }
      setTimeout(() => d.remove(), 900);
    } catch (err) {
      if (status) { status.style.color='#f87171'; status.textContent = String(err); }
    }
  });

  // Reload current disk theme
  d.querySelector('#itt-reload')?.addEventListener('click', async () => {
    const path = getCurrentThemePath();
    if (!path) return;
    if (status) status.textContent = 'Reloading…';
    const result = await loadDiskTheme(path);
    if (result.loaded > 0) {
      if (status) { status.style.color='#34d399'; status.textContent = `Reloaded ${result.loaded} icons.`; }
      setTimeout(() => d.remove(), 700);
    } else {
      if (status) { status.style.color='#f87171'; status.textContent = result.error || 'Reload failed.'; }
    }
  });

  // Remove / unload current disk theme → switch back to Built-in
  d.querySelector('#itt-remove')?.addEventListener('click', () => {
    setIconTheme('builtin');
    d.remove();
  });

  // Close on outside click
  setTimeout(()=>document.addEventListener('mousedown',function h(e){
    if(!e.target.closest('#icon-theme-dialog')){d.remove();document.removeEventListener('mousedown',h);}
  }),0);
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
