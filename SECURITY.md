# Security Policy

## Supported versions

Only the latest release receives security fixes. Older releases are not patched.

| Version | Supported |
|---------|-----------|
| 5.x (latest) | ✓ |
| < 5.0 | ✗ |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately by emailing the maintainers or opening a [GitHub private security advisory](https://github.com/frostfinder/frostfinder/security/advisories/new).

Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (or a proof-of-concept)
- The FrostFinder version and Linux distribution where you observed it
- Whether you have a proposed fix

You will receive an acknowledgement within 72 hours. We aim to release a fix within 14 days for critical issues.

## Threat model

FrostFinder is a local desktop application. It:

- Runs as the current user — it has no elevated privileges
- Reads and writes files on behalf of the user with their own permissions
- Makes no outbound network connections unless the user explicitly mounts a network share (SMB, WebDAV, SFTP, FTP)
- The embedded media HTTP server (`localhost` only, random port) serves files only to the local WebView

**In scope:**

- Privilege escalation through Tauri IPC commands
- Path traversal when handling user-supplied archive or path inputs
- Arbitrary code execution through maliciously crafted archive contents or filenames
- Credential exposure from stored SFTP/FTP/SMB connection details
- WebView sandbox escape via the CSP or asset protocol handler

**Out of scope:**

- Vulnerabilities requiring physical access to the machine
- Social engineering (e.g. tricking the user into deleting their own files)
- Denial of service against a single local user session
- Vulnerabilities in upstream dependencies (Tauri, WebKit2GTK) — report those to their respective projects

## Known limitations

- **CSP `connect-src` wildcard port** — The `connect-src http://127.0.0.1:*` entry covers
  the embedded media server, which binds a deterministic port (written to a lockfile on
  first launch and reused). The CSP will be tightened to the specific port in a future
  release once the port-selection logic is fully stabilised.

## Credential storage

Network-mount credentials are handled as follows:

| Mount type | How credentials are stored |
|---|---|
| SMB/CIFS | 0600 temp file passed via `-o credentials=`; deleted immediately after mount |
| WebDAV | `~/.davfs2/secrets` (0600); entry removed automatically on disconnect |
| SFTP | Key file path only; no passwords stored (key-based auth) |
| FTP/FTPS | No credentials persisted; re-entered on reconnect |
| Cloud (rclone) | OAuth2 tokens managed by rclone in `~/.config/rclone/rclone.conf` |

Passwords are **never** passed as command-line arguments to subprocesses.

## Dependency security

Run `cargo audit` and `npm audit` to check for known vulnerabilities in dependencies:

```bash
cargo install cargo-audit
cargo audit --manifest-path src-tauri/Cargo.toml

npm audit
```

The CI pipeline runs `npm audit --audit-level=high` on every push.
