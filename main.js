const { app, BrowserWindow, Notification, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path  = require('path');
const fs    = require('fs');
const https = require('https');

let win;
let tray;

// ─── File paths ───────────────────────────────────────────────────────────────
const dataFile     = () => path.join(app.getPath('userData'), 'lampdata.json');
const settingsFile = () => path.join(app.getPath('userData'), 'lampwatch-settings.json');

// ─── Default settings ─────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  startup: true,
  slack:   { enabled: false, webhookUrl: '' },
  resend:  { enabled: false, apiKey: '', to: '', from: 'LampWatch <onboarding@resend.dev>' },
};

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8'); } catch {}
}

// ─── Notification cache (per threshold, debounced 24h) ────────────────────────
const notifCache = new Map();
const DAY = 24 * 60 * 60 * 1000;

// ─── Lamp % calculation (mirrors renderer) ────────────────────────────────────
function calcPct(fixture, overrideHPW) {
  const hpw          = overrideHPW || fixture.hoursPerWeek || 10;
  const msElapsed    = Date.now() - new Date(fixture.changedDate).getTime();
  const weeksElapsed = msElapsed / (7 * 24 * 3600 * 1000);
  return (weeksElapsed * hpw) / (fixture.lampHours || 750) * 100;
}

// ─── Slack webhook ────────────────────────────────────────────────────────────
function sendSlack(webhookUrl, alerts) {
  return new Promise((resolve, reject) => {
    const fields = alerts.map(a => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${a.title}*\n${a.body}` },
    }));
    const payload = JSON.stringify({
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🎭 LampWatch — Lamp Alert', emoji: true } },
        ...fields,
        { type: 'context', elements: [{ type: 'mrkdwn', text: `_Sent by LampWatch · ${new Date().toLocaleString()}_` }] },
      ],
    });
    const url = new URL(webhookUrl);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => resolve({ ok: res.statusCode === 200, status: res.statusCode }));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Resend API ───────────────────────────────────────────────────────────────
function sendResend(cfg, alerts) {
  return new Promise((resolve, reject) => {
    const subject = `LampWatch — ${alerts.length} fixture${alerts.length > 1 ? 's' : ''} need attention`;
    const text    = alerts.map(a => `${a.title}\n${a.body}`).join('\n\n');
    const html    = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#1a1a2e;border-bottom:2px solid #2a7de1;padding-bottom:8px">🎭 LampWatch Alert</h2>
        ${alerts.map(a => `
          <div style="background:#f8f9fa;border-left:4px solid #2a7de1;padding:12px 16px;margin:12px 0;border-radius:0 6px 6px 0">
            <strong style="color:#1a1a2e">${a.title}</strong>
            <p style="margin:4px 0 0;color:#444">${a.body}</p>
          </div>`).join('')}
        <p style="color:#999;font-size:12px;margin-top:24px">Sent by LampWatch · ${new Date().toLocaleString()}</p>
      </div>`;

    const payload = JSON.stringify({
      from: cfg.from || 'LampWatch <onboarding@resend.dev>',
      to:   [cfg.to],
      subject, html, text,
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${cfg.apiKey}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200 || res.statusCode === 201, status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Core check ───────────────────────────────────────────────────────────────
async function checkLamps() {
  let fixtures = [], globalHPW = null, globalEnabled = false;
  try {
    const raw = fs.readFileSync(dataFile(), 'utf8');
    const d   = JSON.parse(raw);
    fixtures      = d.fixtures           || [];
    globalHPW     = d.globalHours        || null;
    globalEnabled = d.globalHoursEnabled === true;
  } catch { return; }

  const now      = Date.now();
  const settings = loadSettings();
  const newAlerts = [];

  for (const f of fixtures) {
    const hpw  = (globalEnabled && globalHPW) ? Number(globalHPW) : f.hoursPerWeek;
    const pct  = calcPct(f, hpw);
    const name = [f.label, f.model].filter(Boolean).join(' · ');

    let threshold, title, body;
    if      (pct >= 100) { threshold = 'overdue';  title = '🔴 Lamp Overdue';             body = `${name} — past rated life. Change lamp now.`; }
    else if (pct >=  90) { threshold = 'critical'; title = '🟠 Lamp Change Imminent';     body = `${name} — ${Math.round(pct)}% of rated life used.`; }
    else if (pct >=  80) { threshold = 'warning';  title = '🟡 Approaching End of Life';  body = `${name} — ${Math.round(pct)}% of rated life used.`; }

    if (threshold) {
      const key  = `${f.id}_${threshold}`;
      const last = notifCache.get(key) || 0;
      if (now - last > DAY) {
        notifCache.set(key, now);
        newAlerts.push({ title, body });
        if (Notification.isSupported()) new Notification({ title, body }).show();
      }
    }
  }

  if (newAlerts.length === 0) return;

  if (settings.slack?.enabled && settings.slack?.webhookUrl)
    sendSlack(settings.slack.webhookUrl, newAlerts).catch(() => {});

  if (settings.resend?.enabled && settings.resend?.apiKey && settings.resend?.to)
    sendResend(settings.resend, newAlerts).catch(() => {});
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  const img = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('LampWatch');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open LampWatch',  click: showWindow },
    { label: 'Check Lamps Now', click: () => checkLamps() },
    { type: 'separator' },
    { label: 'Quit LampWatch',  click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function showWindow() {
  if (app.dock) app.dock.show();
  if (win) { win.show(); win.focus(); }
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 820, minWidth: 800, minHeight: 600,
    backgroundColor: '#0b0e17', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });
  win.loadFile('index.html');
  win.on('close', event => {
    if (!app.isQuitting) { event.preventDefault(); win.hide(); if (app.dock) app.dock.hide(); }
  });
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on('save-data',         (_e, data) => { try { fs.writeFileSync(dataFile(), JSON.stringify(data), 'utf8'); } catch {} });
ipcMain.on('notify',            (_e, {title, body}) => { if (Notification.isSupported()) new Notification({ title, body }).show(); });
ipcMain.handle('load-settings', ()         => loadSettings());
ipcMain.on('save-settings',     (_e, s)    => { saveSettings(s); app.setLoginItemSettings({ openAtLogin: !!s.startup, openAsHidden: true }); });
ipcMain.handle('get-startup',   ()         => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('test-slack', async (_e, webhookUrl) => {
  try {
    const r = await sendSlack(webhookUrl, [{ title: '✅ LampWatch Connected', body: 'Slack notifications are working.' }]);
    return { ok: r.ok };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('test-resend', async (_e, cfg) => {
  try {
    const r = await sendResend(cfg, [{ title: '✅ LampWatch Connected', body: 'Email notifications via Resend are working.' }]);
    return { ok: r.ok, error: r.ok ? null : `Status ${r.status}: ${r.data}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const isFirst = !fs.existsSync(settingsFile());
  if (isFirst) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    saveSettings({ ...DEFAULT_SETTINGS, startup: true });
  }
  createTray();
  createWindow();
  setTimeout(checkLamps, 6000);
  setInterval(checkLamps, 60 * 60 * 1000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit',       () => { app.isQuitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
