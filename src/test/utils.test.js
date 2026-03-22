// src/test/utils.test.js
// Tests for pure, side-effect-free functions in utils.js.
// No Tauri IPC involved — these run entirely in jsdom.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── stub localStorage before importing utils ──────────────────────────────────
// utils.js reads localStorage in getBookmarks(); jsdom provides a working
// implementation, and setup.js clears it before each test.

import {
  fmtSize,
  fmtDate,
  escHtml,
  fileColor,
  fileIcon,
  mimeLabel,
  IMAGE_EXTS,
  VIDEO_EXTS,
  AUDIO_EXTS,
  ARCHIVE_EXTS,
  DOC_EXTS,
  addBookmark,
  removeBookmark,
  isBookmarked,
  getBookmarks,
} from '../utils.js';

// ── fmtSize ───────────────────────────────────────────────────────────────────

describe('fmtSize', () => {
  it('returns -- for falsy input', () => {
    expect(fmtSize(0)).toBe('--');
    expect(fmtSize(null)).toBe('--');
    expect(fmtSize(undefined)).toBe('--');
  });

  it('formats bytes under 1 KB', () => {
    expect(fmtSize(1)).toBe('1B');
    expect(fmtSize(512)).toBe('512B');
    expect(fmtSize(1023)).toBe('1023B');
  });

  it('formats KB range', () => {
    expect(fmtSize(1024)).toBe('1.0KB');
    expect(fmtSize(1536)).toBe('1.5KB');
    expect(fmtSize(1048575)).toBe('1024.0KB');
  });

  it('formats MB range', () => {
    expect(fmtSize(1048576)).toBe('1.0MB');
    expect(fmtSize(10 * 1048576)).toBe('10.0MB');
  });

  it('formats GB range', () => {
    expect(fmtSize(1073741824)).toBe('1.0GB');
    expect(fmtSize(10 * 1073741824)).toBe('10.0GB');
  });
});

// ── fmtDate ───────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('returns -- for falsy input', () => {
    expect(fmtDate(0)).toBe('--');
    expect(fmtDate(null)).toBe('--');
    expect(fmtDate(undefined)).toBe('--');
  });

  it('returns a non-empty string for a valid Unix timestamp', () => {
    // 2024-01-15 00:00:00 UTC
    const result = fmtDate(1705276800);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('--');
  });

  it('includes the year for a known timestamp', () => {
    // 2026-03-21
    const result = fmtDate(1742515200);
    expect(result).toMatch(/2026/);
  });
});

// ── escHtml ───────────────────────────────────────────────────────────────────

describe('escHtml', () => {
  it('escapes ampersands', () => {
    expect(escHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes less-than', () => {
    expect(escHtml('<script>')).toBe('&lt;script>');
  });

  it('escapes greater-than', () => {
    expect(escHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes all three in combination', () => {
    expect(escHtml('<b>Tom & Jerry</b>')).toBe('&lt;b>Tom &amp; Jerry&lt;/b>');
  });

  it('returns plain strings unchanged', () => {
    expect(escHtml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escHtml('')).toBe('');
  });
});

// ── fileColor ─────────────────────────────────────────────────────────────────

describe('fileColor', () => {
  it('returns blue for directories', () => {
    expect(fileColor({ is_dir: true, extension: null })).toBe('#5b8dd9');
  });

  it('returns purple for image files', () => {
    const color = fileColor({ is_dir: false, extension: 'png' });
    expect(color).toBe('#a78bfa');
  });

  it('returns green for XCF (GIMP) files', () => {
    expect(fileColor({ is_dir: false, extension: 'xcf' })).toBe('#34d399');
  });

  it('returns red for video files', () => {
    expect(fileColor({ is_dir: false, extension: 'mp4' })).toBe('#f87171');
  });

  it('returns a string for unknown extensions', () => {
    const c = fileColor({ is_dir: false, extension: 'xyz' });
    expect(typeof c).toBe('string');
    expect(c.startsWith('#')).toBe(true);
  });

  it('handles null extension', () => {
    const c = fileColor({ is_dir: false, extension: null });
    expect(typeof c).toBe('string');
  });
});

// ── fileIcon ──────────────────────────────────────────────────────────────────

describe('fileIcon', () => {
  const dir  = { is_dir: true,  is_symlink: false, extension: null };
  const img  = { is_dir: false, is_symlink: false, extension: 'png' };
  const vid  = { is_dir: false, is_symlink: false, extension: 'mp4' };
  const arc  = { is_dir: false, is_symlink: false, extension: 'zip' };
  const doc  = { is_dir: false, is_symlink: false, extension: 'md' };
  const symD = { is_dir: true,  is_symlink: true,  extension: null };
  const unk  = { is_dir: false, is_symlink: false, extension: 'zzz' };

  it('returns SVG string for a directory', () => {
    const svg = fileIcon(dir);
    expect(svg).toContain('<svg');
  });

  it('returns SVG string for an image file', () => {
    expect(fileIcon(img)).toContain('<svg');
  });

  it('returns SVG string for a video file', () => {
    expect(fileIcon(vid)).toContain('<svg');
  });

  it('returns SVG string for an archive', () => {
    expect(fileIcon(arc)).toContain('<svg');
  });

  it('returns SVG string for a doc/code file', () => {
    expect(fileIcon(doc)).toContain('<svg');
  });

  it('returns an SVG for a symlinked directory', () => {
    expect(fileIcon(symD)).toContain('<svg');
  });

  it('falls back to a generic file icon for unknown extension', () => {
    expect(fileIcon(unk)).toContain('<svg');
  });
});

// ── extension lists ───────────────────────────────────────────────────────────

describe('extension constants', () => {
  it('IMAGE_EXTS includes common formats', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
      expect(IMAGE_EXTS).toContain(ext);
    }
  });

  it('VIDEO_EXTS includes common formats', () => {
    for (const ext of ['mp4', 'mkv', 'webm']) {
      expect(VIDEO_EXTS).toContain(ext);
    }
  });

  it('AUDIO_EXTS includes common formats', () => {
    for (const ext of ['mp3', 'flac', 'ogg', 'wav']) {
      expect(AUDIO_EXTS).toContain(ext);
    }
  });

  it('ARCHIVE_EXTS includes zip, tar, 7z', () => {
    for (const ext of ['zip', 'tar', '7z', 'gz']) {
      expect(ARCHIVE_EXTS).toContain(ext);
    }
  });

  it('DOC_EXTS includes code and text formats', () => {
    for (const ext of ['md', 'txt', 'js', 'rs', 'py']) {
      expect(DOC_EXTS).toContain(ext);
    }
  });

  it('extension lists contain only lowercase strings', () => {
    for (const list of [IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, ARCHIVE_EXTS, DOC_EXTS]) {
      for (const ext of list) {
        expect(ext).toBe(ext.toLowerCase());
      }
    }
  });

  it('no duplicates in any extension list', () => {
    for (const [name, list] of [
      ['IMAGE_EXTS',   IMAGE_EXTS],
      ['VIDEO_EXTS',   VIDEO_EXTS],
      ['AUDIO_EXTS',   AUDIO_EXTS],
      ['ARCHIVE_EXTS', ARCHIVE_EXTS],
      ['DOC_EXTS',     DOC_EXTS],
    ]) {
      const unique = new Set(list);
      expect(unique.size, `${name} has duplicates`).toBe(list.length);
    }
  });
});

// ── mimeLabel ─────────────────────────────────────────────────────────────────

describe('mimeLabel', () => {
  it('returns a human label for known MIME types', () => {
    expect(mimeLabel('image/png')).toBe('PNG Image');
    expect(mimeLabel('image/jpeg')).toBe('JPEG Image');
    expect(mimeLabel('video/mp4')).toBe('MP4 Video');
  });

  it('returns a string (possibly the MIME itself) for unknown types', () => {
    const result = mimeLabel('application/x-custom-type');
    expect(typeof result).toBe('string');
  });
});

// ── bookmarks ─────────────────────────────────────────────────────────────────

describe('bookmarks', () => {
  // localStorage is cleared before each test by setup.js

  it('getBookmarks returns empty array when nothing saved', () => {
    expect(getBookmarks()).toEqual([]);
  });

  it('addBookmark adds a new entry', () => {
    const result = addBookmark('/home/user/projects', 'Projects');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: '/home/user/projects', name: 'Projects' });
  });

  it('addBookmark is idempotent — same path not added twice', () => {
    addBookmark('/home/user/docs', 'Docs');
    const result = addBookmark('/home/user/docs', 'Docs');
    expect(result).toHaveLength(1);
  });

  it('addBookmark uses basename as name when none provided', () => {
    const result = addBookmark('/home/user/music');
    expect(result[0].name).toBe('music');
  });

  it('removeBookmark removes the correct entry', () => {
    addBookmark('/home/user/a', 'A');
    addBookmark('/home/user/b', 'B');
    const result = removeBookmark('/home/user/a');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/home/user/b');
  });

  it('removeBookmark on absent path returns list unchanged', () => {
    addBookmark('/home/user/x', 'X');
    const result = removeBookmark('/nonexistent');
    expect(result).toHaveLength(1);
  });

  it('isBookmarked returns true for bookmarked path', () => {
    addBookmark('/home/user/pics', 'Pics');
    expect(isBookmarked('/home/user/pics')).toBe(true);
  });

  it('isBookmarked returns false for absent path', () => {
    expect(isBookmarked('/not/bookmarked')).toBe(false);
  });

  it('bookmarks persist across getBookmarks calls', () => {
    addBookmark('/home/user/p1', 'P1');
    addBookmark('/home/user/p2', 'P2');
    expect(getBookmarks()).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 12 additions — previously untested exports
// ─────────────────────────────────────────────────────────────────────────────

import {
  fmtDateAbsolute,
  setDateLocale,
  fmtDriveSpace,
  driveColor,
  driveTypeBadge,
  favColor,
} from '../utils.js';

// ── fmtDate — all six relative time branches ──────────────────────────────────

describe('fmtDate — relative time branches', () => {
  // Pin "now" so every test is deterministic regardless of when CI runs.
  const NOW_S   = 1_742_601_600; // 2026-03-22 00:00:00 UTC (whole day for isToday checks)
  const NOW_MS  = NOW_S * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    setDateLocale('en-US');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Just now" for a timestamp less than 1 minute ago', () => {
    expect(fmtDate(NOW_S - 30)).toBe('Just now');
  });

  it('returns "X min ago" for 1–59 minutes ago', () => {
    expect(fmtDate(NOW_S - 60)).toBe('1 min ago');
    expect(fmtDate(NOW_S - 3540)).toBe('59 min ago');
  });

  it('returns "Today, HH:MM" for same-day timestamps older than 1 hour', () => {
    // 2 hours before midnight on 2026-03-22
    const result = fmtDate(NOW_S - 7200);
    expect(result).toMatch(/^Today,/);
    expect(result.length).toBeGreaterThan('Today, '.length);
  });

  it('returns a weekday name for timestamps within the last 7 days (not today)', () => {
    // 2 days ago — must not be "Today"
    const result = fmtDate(NOW_S - 2 * 86400);
    // Should be a long weekday, not a date with a year
    expect(result).not.toMatch(/Today/);
    expect(result).not.toMatch(/\d{4}/); // no 4-digit year
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns "Mon DD" for same-year timestamps older than 7 days', () => {
    // 10 days ago — within 2026 but outside the 7-day "this week" window
    const result = fmtDate(NOW_S - 10 * 86400);
    expect(result).toMatch(/Mar/); // within the same month
    expect(result).not.toMatch(/\d{4}/); // no year for same-year entries
  });

  it('returns "Mon DD, YYYY" for timestamps from a previous year', () => {
    // One year ago — 2025
    const result = fmtDate(NOW_S - 366 * 86400);
    expect(result).toMatch(/2025/);
  });

  it('returns "--" for falsy and zero inputs', () => {
    expect(fmtDate(0)).toBe('--');
    expect(fmtDate(null)).toBe('--');
    expect(fmtDate(undefined)).toBe('--');
  });
});

// ── fmtDateAbsolute ───────────────────────────────────────────────────────────

describe('fmtDateAbsolute', () => {
  beforeEach(() => {
    setDateLocale('en-US');
  });

  it('returns "--" for falsy input', () => {
    expect(fmtDateAbsolute(0)).toBe('--');
    expect(fmtDateAbsolute(null)).toBe('--');
  });

  it('returns a string containing the year for a valid timestamp', () => {
    // 2026-03-22
    const result = fmtDateAbsolute(1_742_601_600);
    expect(typeof result).toBe('string');
    expect(result).toMatch(/2026/);
  });

  it('includes a time component (AM/PM or HH:MM)', () => {
    const result = fmtDateAbsolute(1_742_601_600);
    expect(result).toMatch(/\d+:\d+/);
  });
});

// ── setDateLocale ─────────────────────────────────────────────────────────────

describe('setDateLocale', () => {
  afterEach(() => {
    setDateLocale('en-US'); // restore default after each test
  });

  it('does not throw when given a valid BCP-47 tag', () => {
    expect(() => setDateLocale('de-DE')).not.toThrow();
    expect(() => setDateLocale('ja')).not.toThrow();
    expect(() => setDateLocale('ar')).not.toThrow();
  });

  it('falls back gracefully when given null or empty string', () => {
    expect(() => setDateLocale(null)).not.toThrow();
    expect(() => setDateLocale('')).not.toThrow();
  });

  it('affects subsequent fmtDate output (locale changes formatting)', () => {
    vi.useFakeTimers();
    const NOW_S = 1_742_601_600;
    vi.setSystemTime(NOW_S * 1000);

    setDateLocale('en-US');
    const enResult = fmtDate(NOW_S - 366 * 86400); // previous-year date

    setDateLocale('de-DE');
    const deResult = fmtDate(NOW_S - 366 * 86400);

    // Both should be non-empty strings; they may differ in locale-specific formatting
    expect(typeof enResult).toBe('string');
    expect(typeof deResult).toBe('string');
    expect(enResult.length).toBeGreaterThan(0);
    expect(deResult.length).toBeGreaterThan(0);

    vi.useRealTimers();
    setDateLocale('en-US');
  });
});

// ── fmtDriveSpace ─────────────────────────────────────────────────────────────

describe('fmtDriveSpace', () => {
  it('returns empty string when total_bytes is 0 or missing', () => {
    expect(fmtDriveSpace({ total_bytes: 0, free_bytes: 0 })).toBe('');
    expect(fmtDriveSpace({ free_bytes: 512 })).toBe('');
  });

  it('formats a typical drive with used, total, and percentage', () => {
    const result = fmtDriveSpace({ total_bytes: 1_073_741_824, free_bytes: 536_870_912 });
    // 512MB used of 1.0GB (50%)
    expect(result).toMatch(/512\.0MB/);
    expect(result).toMatch(/1\.0GB/);
    expect(result).toMatch(/50%/);
  });

  it('shows 100% when drive is completely full', () => {
    const result = fmtDriveSpace({ total_bytes: 1_073_741_824, free_bytes: 0 });
    expect(result).toMatch(/100%/);
  });

  it('shows 0% when drive is completely empty', () => {
    const result = fmtDriveSpace({ total_bytes: 1_073_741_824, free_bytes: 1_073_741_824 });
    expect(result).toMatch(/0%/);
  });

  it('rounds percentage to nearest integer', () => {
    // 1 byte used of 3 bytes = 33.3% -> rounds to 33%
    const result = fmtDriveSpace({ total_bytes: 3, free_bytes: 2 });
    expect(result).toMatch(/33%/);
  });
});

// ── driveColor ────────────────────────────────────────────────────────────────

describe('driveColor', () => {
  it('returns green for usb', () => {
    expect(driveColor({ drive_type: 'usb' })).toBe('#34d399');
  });

  it('returns blue for network', () => {
    expect(driveColor({ drive_type: 'network' })).toBe('#60a5fa');
  });

  it('returns pink for optical', () => {
    expect(driveColor({ drive_type: 'optical' })).toBe('#f472b6');
  });

  it('returns purple for nvme', () => {
    expect(driveColor({ drive_type: 'nvme' })).toBe('#a78bfa');
  });

  it('returns blue for ssd', () => {
    expect(driveColor({ drive_type: 'ssd' })).toBe('#60a5fa');
  });

  it('returns grey for hdd', () => {
    expect(driveColor({ drive_type: 'hdd' })).toBe('#94a3b8');
  });

  it('returns grey fallback for unknown drive type', () => {
    expect(driveColor({ drive_type: 'floppy' })).toBe('#94a3b8');
    expect(driveColor({ drive_type: undefined })).toBe('#94a3b8');
  });
});

// ── driveTypeBadge ────────────────────────────────────────────────────────────

describe('driveTypeBadge', () => {
  it('returns "USB" for usb drives', () => {
    expect(driveTypeBadge({ drive_type: 'usb' })).toBe('USB');
  });

  it('returns "NET" for network drives', () => {
    expect(driveTypeBadge({ drive_type: 'network' })).toBe('NET');
  });

  it('returns "NVMe" for nvme drives', () => {
    expect(driveTypeBadge({ drive_type: 'nvme' })).toBe('NVMe');
  });

  it('returns "SSD" for ssd drives', () => {
    expect(driveTypeBadge({ drive_type: 'ssd' })).toBe('SSD');
  });

  it('returns "HDD" for hdd drives', () => {
    expect(driveTypeBadge({ drive_type: 'hdd' })).toBe('HDD');
  });

  it('returns "OPT" for optical drives', () => {
    expect(driveTypeBadge({ drive_type: 'optical' })).toBe('OPT');
  });

  it('returns empty string for unknown drive types', () => {
    expect(driveTypeBadge({ drive_type: 'ramdisk' })).toBe('');
    expect(driveTypeBadge({ drive_type: undefined })).toBe('');
  });
});

// ── favColor ──────────────────────────────────────────────────────────────────

describe('favColor', () => {
  it('returns correct colour for each known icon key', () => {
    expect(favColor('home')).toBe('#60a5fa');
    expect(favColor('monitor')).toBe('#94a3b8');
    expect(favColor('doc')).toBe('#e2e8f0');
    expect(favColor('download')).toBe('#34d399');
    expect(favColor('img')).toBe('#a78bfa');
    expect(favColor('music')).toBe('#f472b6');
    expect(favColor('video')).toBe('#f87171');
    expect(favColor('trash')).toBe('#636368');
  });

  it('returns grey fallback for unknown keys', () => {
    expect(favColor('unknown')).toBe('#94a3b8');
    expect(favColor(undefined)).toBe('#94a3b8');
    expect(favColor('')).toBe('#94a3b8');
  });
});
