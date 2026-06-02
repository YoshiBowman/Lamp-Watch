const { app, BrowserWindow, Notification, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const os    = require('os');
const dgram = require('dgram');

let win;
let tray;

// ─── File paths ───────────────────────────────────────────────────────────────
const dataFile     = () => path.join(app.getPath('userData'), 'lampdata.json');
const settingsFile = () => path.join(app.getPath('userData'), 'lampwatch-settings.json');

// ─── Default settings ─────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  startup:   true,
  slack:     { enabled: false, webhookUrl: '' },
  resend:    { enabled: false, apiKey: '', to: '', from: 'LampWatch <onboarding@resend.dev>' },
  dmxMaster: { enabled: false, protocol: 'sacn', universe: 1, channel: 1, nic: '' },
};

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      dmxMaster: { ...DEFAULT_SETTINGS.dmxMaster, ...(parsed.dmxMaster || {}) },
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8'); } catch {}
}

// ─── NIC enumeration ──────────────────────────────────────────────────────────
function getNICs() {
  const result = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal)
        result.push({ name, ip: addr.address, label: `${name} — ${addr.address}` });
    }
  }
  return result;
}

// ─── DMX timer state ──────────────────────────────────────────────────────────
let dmxActive        = false;
let dmxTimerInterval = null;
let autosaveInterval = null;
let sacnReceiver     = null;
let artnetSocket     = null;
let accumulatedMap   = {};   // { fixtureId: seconds }
let currentFixtures  = [];   // cached from last save-data

// ─── Persistence ─────────────────────────────────────────────────────────────
function loadAccumulatedSeconds() {
  try {
    const d = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    const map = {};
    for (const f of (d.fixtures || []))
      map[f.id] = f.accumulatedSeconds || 0;
    return map;
  } catch { return {}; }
}

function saveAccumulatedSeconds() {
  try {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch {}
    const fixtures = (data.fixtures || []).map(f => ({
      ...f,
      accumulatedSeconds: accumulatedMap[f.id] !== undefined
        ? accumulatedMap[f.id]
        : (f.accumulatedSeconds || 0),
    }));
    fs.writeFileSync(dataFile(), JSON.stringify({ ...data, fixtures }), 'utf8');
  } catch {}
}

// ─── Core DMX value handler ───────────────────────────────────────────────────
function handleDMXValue(value) {
  const isActive = value > 0;
  if (isActive === dmxActive) return;
  dmxActive = isActive;

  if (isActive) {
    // Start per-second timer
    dmxTimerInterval = setInterval(() => {
      for (const f of currentFixtures) {
        if (accumulatedMap[f.id] === undefined) accumulatedMap[f.id] = f.accumulatedSeconds || 0;
        accumulatedMap[f.id]++;
      }
      if (win && !win.isDestroyed())
        win.webContents.send('dmx-tick', { ...accumulatedMap });
    }, 1000);

    autosaveInterval = setInterval(saveAccumulatedSeconds, 10_000);
  } else {
    // Pause — save immediately
    if (dmxTimerInterval)  { clearInterval(dmxTimerInterval);  dmxTimerInterval = null; }
    if (autosaveInterval)  { clearInterval(autosaveInterval);  autosaveInterval = null; }
    saveAccumulatedSeconds();
  }

  if (win && !win.isDestroyed())
    win.webContents.send('dmx-state-change', { active: isActive });
}

// ─── sACN (E1.31) listener ────────────────────────────────────────────────────
function startSACNListener(config) {
  try {
    const { Receiver } = require('sacn');
    sacnReceiver = new Receiver({
      universes:  [config.universe],
      iface:      config.nicIp || undefined,
      reuseAddr:  true,
    });

    const onPacket = (packet) => {
      const buf   = packet.payloadAsBuffer;
      const value = buf ? (buf[config.channel - 1] || 0) : 0;
      handleDMXValue(value);
    };
    sacnReceiver.on('packet',   onPacket);
    sacnReceiver.on('universe', onPacket);
    sacnReceiver.on('error', (e) => {
      console.error('[sACN] error:', e.message);
      if (e.code === 'EADDRINUSE') {
        if (win && !win.isDestroyed())
          win.webContents.send('dmx-error', { message: 'Port 5568 is already in use. Quit any other sACN app (e.g. Prism) and re-save DMX settings.' });
      }
    });
  } catch (e) {
    console.error('[sACN] Failed to start:', e.message);
  }
}

// ─── Art-Net listener (built-in dgram, no extra package) ─────────────────────
function startArtNetListener(config) {
  artnetSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  artnetSocket.bind(6454, config.nicIp || '', () => {
    try { artnetSocket.setBroadcast(true); } catch {}
  });
  artnetSocket.on('message', (msg) => {
    if (msg.length < 18) return;
    if (msg.slice(0, 8).toString('ascii') !== 'Art-Net\0') return;
    const opcode = msg.readUInt16LE(8);
    if (opcode !== 0x5000) return; // ArtDmx
    const portAddr = ((msg[15] & 0x7F) << 8) | msg[14];
    if (portAddr !== config.universe) return;
    if (msg.length < 18 + config.channel) return;
    handleDMXValue(msg[18 + config.channel - 1]);
  });
  artnetSocket.on('error', (e) => console.error('[Art-Net]', e.message));
}

// ─── Seed accumulatedMap from math estimate for fixtures with no recorded time ─
function seedFromMathEstimate() {
  // Pull freshest fixture list (currentFixtures if populated, else disk)
  let fixtures = currentFixtures;
  if (fixtures.length === 0) {
    try { fixtures = JSON.parse(fs.readFileSync(dataFile(), 'utf8')).fixtures || []; } catch {}
  }
  if (fixtures.length > 0) currentFixtures = fixtures;

  const now = Date.now();
  for (const f of fixtures) {
    // Only seed if no real accumulated time has been recorded yet
    if (!accumulatedMap[f.id]) {
      const msElapsed    = Math.max(0, now - new Date(f.changedDate).getTime());
      const weeksElapsed = msElapsed / (7 * 24 * 3600 * 1000);
      const mathSeconds  = Math.round(weeksElapsed * (f.hoursPerWeek || 10) * 3600);
      if (mathSeconds > 0) accumulatedMap[f.id] = mathSeconds;
    }
  }
}

// ─── Start / stop DMX ────────────────────────────────────────────────────────
function startDMX(config) {
  stopDMX();
  accumulatedMap = loadAccumulatedSeconds();
  // Seed any fixture that has 0 accumulated time from the math estimate
  // so switching to DMX mode doesn't wipe out existing lamp history
  seedFromMathEstimate();

  // Push seeded values to renderer immediately so UI updates without waiting for first tick
  if (win && !win.isDestroyed())
    win.webContents.send('dmx-tick', { ...accumulatedMap });

  const nics   = getNICs();
  const nicEntry = nics.find(n => n.name === config.nic);
  const nicIp  = nicEntry ? nicEntry.ip : '';
  const cfg    = { ...config, nicIp };

  if (config.protocol === 'sacn') startSACNListener(cfg);
  else                             startArtNetListener(cfg);
}

function stopDMX() {
  if (dmxActive) handleDMXValue(0); // triggers save + stop
  if (sacnReceiver) { try { sacnReceiver.close(); } catch {} sacnReceiver = null; }
  if (artnetSocket) { try { artnetSocket.close(); } catch {} artnetSocket = null; }
  dmxActive = false;
}

// ─── Notification cache ──────────────────────────────────────────────────────
const notifCache = new Map();
const DAY = 24 * 60 * 60 * 1000;

// ─── Lamp % calculation ───────────────────────────────────────────────────────
function calcPct(fixture, overrideHPW) {
  const hpw          = overrideHPW || fixture.hoursPerWeek || 10;
  const msElapsed    = Date.now() - new Date(fixture.changedDate).getTime();
  const weeksElapsed = msElapsed / (7 * 24 * 3600 * 1000);
  return (weeksElapsed * hpw) / (fixture.lampHours || 750) * 100;
}

// ─── Slack webhook ────────────────────────────────────────────────────────────
function sendSlack(webhookUrl, alerts) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🎭 LampWatch — Lamp Alert', emoji: true } },
        ...alerts.map(a => ({ type: 'section', text: { type: 'mrkdwn', text: `*${a.title}*\n${a.body}` } })),
        { type: 'context', elements: [{ type: 'mrkdwn', text: `_Sent by LampWatch · ${new Date().toLocaleString()}_` }] },
      ],
    });
    const url = new URL(webhookUrl);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => resolve({ ok: res.statusCode === 200 }));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ─── Resend API ───────────────────────────────────────────────────────────────
function sendResend(cfg, alerts) {
  return new Promise((resolve, reject) => {
    const subject = `LampWatch — ${alerts.length} fixture${alerts.length > 1 ? 's' : ''} need attention`;
    const html = `<div style="font-family:sans-serif;max-width:600px">
      <h2 style="color:#1a1a2e;border-bottom:2px solid #2a7de1;padding-bottom:8px">🎭 LampWatch Alert</h2>
      ${alerts.map(a => `<div style="background:#f8f9fa;border-left:4px solid #2a7de1;padding:12px 16px;margin:12px 0;border-radius:0 6px 6px 0">
        <strong>${a.title}</strong><p style="margin:4px 0 0;color:#444">${a.body}</p></div>`).join('')}
      <p style="color:#999;font-size:12px;margin-top:24px">Sent by LampWatch · ${new Date().toLocaleString()}</p></div>`;
    const payload = JSON.stringify({ from: cfg.from || 'LampWatch <onboarding@resend.dev>', to: [cfg.to], subject, html, text: alerts.map(a => `${a.title}\n${a.body}`).join('\n\n') });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200 || res.statusCode === 201, status: res.statusCode, data: d }));
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

// ─── Hourly lamp check ────────────────────────────────────────────────────────
async function checkLamps() {
  let fixtures = [], globalHPW = null, globalEnabled = false;
  try {
    const d = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    fixtures      = d.fixtures           || [];
    globalHPW     = d.globalHours        || null;
    globalEnabled = d.globalHoursEnabled === true;
  } catch { return; }

  const settings   = loadSettings();
  const dmxEnabled = settings.dmxMaster?.enabled;
  const now        = Date.now();
  const newAlerts  = [];

  for (const f of fixtures) {
    let pct;
    if (dmxEnabled) {
      const secs = accumulatedMap[f.id] !== undefined ? accumulatedMap[f.id] : (f.accumulatedSeconds || 0);
      pct = (secs / 3600) / (f.lampHours || 750) * 100;
    } else {
      const hpw = (globalEnabled && globalHPW) ? Number(globalHPW) : f.hoursPerWeek;
      pct = calcPct(f, hpw);
    }

    const name = [f.label, f.model].filter(Boolean).join(' · ');
    let threshold, title, body;
    if      (pct >= 100) { threshold = 'overdue';  title = '🔴 Lamp Overdue';            body = `${name} — past rated life. Change lamp now.`; }
    else if (pct >=  90) { threshold = 'critical'; title = '🟠 Lamp Change Imminent';    body = `${name} — ${Math.round(pct)}% of rated life used.`; }
    else if (pct >=  80) { threshold = 'warning';  title = '🟡 Approaching End of Life'; body = `${name} — ${Math.round(pct)}% of rated life used.`; }

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
  if (settings.slack?.enabled  && settings.slack?.webhookUrl)           sendSlack(settings.slack.webhookUrl, newAlerts).catch(() => {});
  if (settings.resend?.enabled && settings.resend?.apiKey && settings.resend?.to) sendResend(settings.resend, newAlerts).catch(() => {});
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
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
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
      if (app.dock) app.dock.hide();
    }
  });
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on('save-data', (_e, data) => {
  const newFixtures = data.fixtures || [];
  // Init accumMap for any new fixtures; never overwrite existing live values
  for (const f of newFixtures)
    if (accumulatedMap[f.id] === undefined) accumulatedMap[f.id] = f.accumulatedSeconds || 0;
  currentFixtures = newFixtures;
  // Always write main's accumulatedMap values to disk (source of truth)
  const out = newFixtures.map(f => ({
    ...f,
    accumulatedSeconds: accumulatedMap[f.id] !== undefined ? accumulatedMap[f.id] : (f.accumulatedSeconds || 0),
  }));
  try { fs.writeFileSync(dataFile(), JSON.stringify({ ...data, fixtures: out }), 'utf8'); } catch {}
});

ipcMain.on('notify',            (_e, {title, body}) => { if (Notification.isSupported()) new Notification({ title, body }).show(); });
ipcMain.handle('load-settings', ()          => loadSettings());
ipcMain.on('save-settings',     (_e, s)    => {
  saveSettings(s);
  app.setLoginItemSettings({ openAtLogin: !!s.startup, openAsHidden: true });
  if (s.dmxMaster?.enabled) startDMX(s.dmxMaster);
  else                       stopDMX();
});
ipcMain.handle('get-startup',   ()          => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('get-nics',      ()          => getNICs());
ipcMain.handle('get-dmx-state', ()          => ({ active: dmxActive, accumulated: { ...accumulatedMap } }));
ipcMain.on('reset-fixture-timer', (_e, id) => {
  accumulatedMap[id] = 0;
  saveAccumulatedSeconds();
  if (win && !win.isDestroyed()) win.webContents.send('dmx-tick', { ...accumulatedMap });
});

ipcMain.handle('test-slack', async (_e, url) => {
  try { const r = await sendSlack(url, [{ title: '✅ LampWatch Connected', body: 'Slack notifications are working.' }]); return { ok: r.ok }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('test-resend', async (_e, cfg) => {
  try { const r = await sendResend(cfg, [{ title: '✅ LampWatch Connected', body: 'Email notifications via Resend are working.' }]); return { ok: r.ok, error: r.ok ? null : `Status ${r.status}: ${r.data}` }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const isFirst = !fs.existsSync(settingsFile());
  if (isFirst) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    saveSettings({ ...DEFAULT_SETTINGS, startup: true });
  }

  // Bootstrap accumulated seconds and fixture list from disk
  try {
    const d = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    currentFixtures = d.fixtures || [];
    accumulatedMap  = loadAccumulatedSeconds();
  } catch {}

  createTray();
  createWindow();

  // If DMX was enabled, seed + restart listener once renderer is ready to receive ticks
  win.webContents.once('did-finish-load', () => {
    const settings = loadSettings();
    if (settings.dmxMaster?.enabled) {
      // Give renderer a moment to register its IPC listeners before we push values
      setTimeout(() => startDMX(settings.dmxMaster), 500);
    }
  });

  setTimeout(checkLamps, 6000);
  setInterval(checkLamps, 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (dmxActive) saveAccumulatedSeconds(); // final save on quit
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
