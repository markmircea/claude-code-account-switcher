// Desktop notification (Windows popup, Linux notify-send) when the gateway moves a conversation to another account, or when the pool
// reopens. No external program, no install, no module: one short-lived powershell.exe.
//
// Order matters and was learned by being wrong. The WinRT toast path reports exit code 0 when
// Windows silently drops the notification (an unregistered AppUserModelID can be swallowed without
// any error), so it cannot be trusted to mean "the user saw it" - measured on this box, `cla-gw
// notify` said "sent via toast" and nothing appeared. The topmost popup below is drawn by us, so
// "it ran" and "it was visible" are the same event. Toast/balloon stay as fallbacks in case the
// popup path is ever blocked.
//
// Fire-and-forget: a notification must never add latency to, or fail, an inference request.

import { spawn } from 'node:child_process';

const THROTTLE_MS = 5 * 60 * 1000; // per from->to pair; alternating accounts must not spam
const POPUP_MS = Number(process.env.CLAUDE_GW_NOTIFY_MS || 9000);
const lastNotice = new Map();

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// PowerShell single-quoted strings end at a quote; strip the characters that would break them.
const safe = (s) => String(s).replace(/['"`$\r\n]/g, ' ').trim();

// The primary path: a small borderless box, bottom-right above the taskbar, no taskbar entry,
// self-closing, click to dismiss. A named mutex means five chats hitting the same limit produce one
// popup rather than five stacked ones.
function popupScript(title, body, ms) {
  const t = safe(title), b = safe(body);
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$mx=New-Object System.Threading.Mutex($false,'claude-gw-notify')",
    'if(-not $mx.WaitOne(0)){exit 0}',
    '$f=New-Object System.Windows.Forms.Form',
    "$f.FormBorderStyle='None'",
    '$f.Topmost=$true',
    '$f.ShowInTaskbar=$false',
    '$f.ShowIcon=$false',
    '$f.BackColor=[System.Drawing.Color]::FromArgb(24,24,28)',
    '$f.Size=New-Object System.Drawing.Size(360,76)',
    '[void]$f.Add_Click({$f.Close()})',
    '$wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$f.Location=New-Object System.Drawing.Point(($wa.Right-372),($wa.Bottom-88))',
    '$l=New-Object System.Windows.Forms.Label',
    '$l.ForeColor=[System.Drawing.Color]::White',
    '$l.AutoSize=$false',
    '$l.SetBounds(14,10,332,56)',
    '$l.Font=New-Object System.Drawing.Font("Segoe UI",10,[System.Drawing.FontStyle]::Bold)',
    "$l.Text='" + t + "'+[char]13+'" + b + "'",
    '$f.Controls.Add($l)',
    '$t=New-Object System.Windows.Forms.Timer',
    '$t.Interval=' + Math.max(1500, Math.min(60000, ms | 0)),
    '$t.Add_Tick({$f.Close()})',
    '$t.Start()',
    '[void]$f.ShowDialog()',
    '$t.Dispose()',
    '$f.Dispose()',
    '$mx.ReleaseMutex()',
  ].join('; ');
}

function toastScript(title, body) {
  const xml = `<toast><visual><binding template="ToastGeneric">` +
    `<text>${esc(title)}</text><text>${esc(body)}</text></binding></visual>` +
    `<audio src="ms-winsoundevent:Notification.Default"/></toast>`;
  return [
    "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]",
    "$x=New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$x.LoadXml('${xml}')`,
    "$n=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('claude-gw')",
    "$n.Show([Windows.UI.Notifications.ToastNotification]::new($x))",
  ].join('\n');
}

function balloonScript(title, body) {
  const t = safe(title), b = safe(body);
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$i=New-Object System.Windows.Forms.NotifyIcon',
    '$i.Icon=[System.Drawing.SystemIcons]::Information',
    '$i.Visible=$true',
    `$i.ShowBalloonTip(6000,'${t}','${b}','Info')`,
    'Start-Sleep -Seconds 4',
    '$i.Dispose()',
  ].join('; ');
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
    // A popup is modal inside its own powershell process; that process dying on the timer is normal,
    // and an unresponsive desktop must never hang the gateway.
    setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(false); }, 90000);
  });
}

// Linux: libnotify's notify-send, which reaches the desktop's notification daemon over the session
// D-Bus. A systemd --user unit inherits DBUS_SESSION_BUS_ADDRESS, so this works from the service too.
// Title and body are separate argv entries with no shell in between, so nothing needs escaping. With
// no desktop session (SSH only) there is no daemon to talk to: that is reported, never thrown.
function notifySend(title, body) {
  return new Promise((resolve) => {
    const child = spawn('notify-send', ['--app-name=claude-gw', `--expire-time=${POPUP_MS}`, String(title), String(body)],
      { stdio: 'ignore' });
    child.on('error', () => resolve('unavailable (notify-send missing)'));
    child.on('exit', (code) => resolve(code === 0 ? 'notify-send' : 'unavailable (no desktop session?)'));
    setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve('unavailable (timed out)'); }, 15000);
  });
}

export async function notify(title, body = '') {
  if (process.env.CLAUDE_GW_NO_NOTIFY) return 'disabled'; // tests: no popups on the user's screen
  if (process.platform !== 'win32') return notifySend(title, body);
  if (await runPowerShell(popupScript(title, body, POPUP_MS))) return 'popup';
  if (await runPowerShell(toastScript(title, body))) return 'toast'; // note: "ran", not "seen"
  await runPowerShell(balloonScript(title, body));
  return 'balloon';
}

// A terms wall cannot be fixed by waiting, so it is worth interrupting for - but only once per park.
const consentNoticed = new Map();
export function notifyConsent(label, org = '') {
  const now = Date.now();
  if (now - (consentNoticed.get(label) || 0) < 30 * 60 * 1000) return false;
  consentNoticed.set(label, now);
  // A setup-token cannot report its email, so the org id is the only handle on WHICH account this is.
  notify(`claude-gw: ${label} needs the terms accepted`,
    `org ${String(org).slice(0, 8) || 'unknown'} - open claude.ai as that account and accept; parked 30 min`);
  return true;
}

export function notifySwitch(from, to, why = '') {
  const key = `${from}->${to}`;
  const now = Date.now();
  if (now - (lastNotice.get(key) || 0) < THROTTLE_MS) return false;
  lastNotice.set(key, now);
  const when = new Date().toLocaleTimeString();
  notify(`claude-gw: ${from} -> ${to}`, `${why || 'account switched'} at ${when}`);
  return true;
}

// The pool was fully limited and has just reopened. A chat that refused at the limit is usually still
// sitting there with its turn ended, so this says what to do rather than just that something changed.
export function notifyPoolOpen(label, at = new Date()) {
  const when = at.toLocaleTimeString();
  notify(`claude-gw: ${label} is back (${when})`, 'type continue in any chat that stopped at the limit');
  return true;
}
