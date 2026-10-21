// Windows notification when the gateway moves a conversation to another account.
// No dependencies: PowerShell 5.1 is always present. Tries a real toast first, falls back to a
// balloon tip (NotifyIcon) because an unregistered app can silently swallow toasts.
//
// Fire-and-forget: a notification must never add latency to, or fail, an inference request.

import { spawn } from 'node:child_process';

const THROTTLE_MS = 5 * 60 * 1000; // per from->to pair; alternating accounts must not spam
const lastNotice = new Map();

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
  // Single quotes inside the strings would break these; strip them.
  const t = String(title).replace(/['"]/g, ''), b = String(body).replace(/['"]/g, '');
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$i=New-Object System.Windows.Forms.NotifyIcon([System.Drawing.SystemIcons]::Information)`,
    '$i.Visible=$true',
    `$i.ShowBalloonTip(6000,'${t}','${b}')`,
    'Start-Sleep -Seconds 4',
    '$i.Dispose()',
  ].join('\n');
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
    setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(false); }, 10000);
  });
}

export async function notify(title, body = '') {
  if (process.env.CLAUDE_GW_NO_NOTIFY) return 'disabled'; // tests: no toasts on the user's screen
  if (await runPowerShell(toastScript(title, body))) return 'toast';
  await runPowerShell(balloonScript(title, body));
  return 'balloon';
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
