// Vault: DPAPI (CurrentUser) encrypted blobs under %LOCALAPPDATA%\claude-gw\vault\.
//
// Why this shape:
//  - Windows Credential Manager cannot be *read* back programmatically without the CredRead API,
//    so it is not usable as a store we can poll. DPAPI via powershell.exe (5.1, always present)
//    gives per-user encryption with no native Node dependency.
//  - The secret is passed over STDIN, never as a command-line argument: process arguments are
//    visible to every other process on the machine (and to process-audit tooling).
//  - Decryption is done once and cached in memory. Per-request subprocess spawns would add
//    hundreds of ms to every inference call for no benefit.
//
// Caveat stated honestly: DPAPI CurrentUser means anything running as this user can decrypt it.
// It protects the token at rest, not from a process already running as you.
//
// Linux has no DPAPI. There the store is a plain file only this user can read (0600 inside a 0700
// dir): the same protection Claude Code gives its own login on Linux (~/.claude/.credentials.json),
// with the same honest caveat. Not libsecret on purpose: the gateway starts as a systemd --user unit,
// often before (or without) a desktop login, when the keyring is still locked. A vault file that has
// become group/world readable is refused rather than used.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const VAULT_DIR = path.join(DATA_DIR, 'vault');
const ENTROPY = 'claude-gw-vault-v1';
const PS = 'powershell.exe'; // 5.1: ProtectedData is built in. pwsh/core may not have it.
const IS_WIN = process.platform === 'win32';
const EXT = IS_WIN ? '.dpapi' : '.token';

// NOTE on the PowerShell specifics, each of which was got wrong once:
//  - ProtectedData lives in the `System.Security` assembly on .NET Framework (5.1). Asking for
//    `System.Security.Cryptography` fails once stdin is redirected, which is exactly how we call it.
//  - The base64 helpers are ToBase64String / FromBase64String.
const PROTECT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$in=[Console]::In.ReadToEnd().Trim()
$b=[Text.Encoding]::UTF8.GetBytes($in)
$enc=[Security.Cryptography.ProtectedData]::Protect($b,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($enc)
`;

const UNPROTECT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$b=[Convert]::FromBase64String((Get-Content -Raw -LiteralPath '${'__FILE__'}').Trim())
$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($d)
`;

export function vaultPath(label) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(label)) throw new Error(`invalid label: ${label}`);
  return path.join(VAULT_DIR, `${label}${EXT}`);
}

function ensureVaultDir() {
  fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  if (!IS_WIN) fs.chmodSync(VAULT_DIR, 0o700); // mkdir's mode is masked by umask and skipped if it existed
}

export function vaultPut(label, secret) {
  ensureVaultDir();
  const file = vaultPath(label);
  if (!IS_WIN) {
    const value = String(secret).trim();
    if (!value) throw new Error('refusing to vault an empty secret');
    // Created 0600 under a temp name, then renamed: the token is never on disk with wider permissions,
    // and a reader never sees a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, value, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    cache.delete(label);
    return file;
  }
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', PROTECT], {
    input: String(secret).trim(), encoding: 'utf8', windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`vault encrypt failed: ${(r.stderr || '').trim().slice(0, 300)}`);
  const b64 = (r.stdout || '').trim();
  if (!b64) throw new Error('vault encrypt produced no output');
  fs.writeFileSync(file, b64, { mode: 0o600 });
  cache.delete(label);
  return file;
}

const cache = new Map(); // label -> { mtimeMs, value }

export function vaultGet(label) {
  const file = vaultPath(label);
  if (!fs.existsSync(file)) return { err: 'no-vault-entry' };
  const stat = fs.statSync(file);
  const mtimeMs = stat.mtimeMs;
  if (!IS_WIN && (stat.mode & 0o077)) {
    return { err: `vault file is readable by other users (mode ${(stat.mode & 0o777).toString(8)}); run: chmod 600 ${file}` };
  }
  const hit = cache.get(label);
  if (hit && hit.mtimeMs === mtimeMs) return { token: hit.value, cached: true };
  if (!IS_WIN) {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!token) return { err: 'vault-empty' };
    cache.set(label, { mtimeMs, value: token });
    return { token };
  }
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command',
    UNPROTECT.replace('__FILE__', file)], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return { err: `vault decrypt failed: ${(r.stderr || '').trim().slice(0, 200)}` };
  const token = (r.stdout || '').trim();
  if (!token) return { err: 'vault-empty' };
  cache.set(label, { mtimeMs, value: token });
  return { token };
}

export function vaultLs() {
  try {
    return fs.readdirSync(VAULT_DIR)
      .filter((f) => f.endsWith(EXT))
      .map((f) => f.slice(0, -EXT.length));
  } catch { return []; }
}

export function vaultRm(label) {
  const file = vaultPath(label);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  cache.delete(label);
  return true;
}
