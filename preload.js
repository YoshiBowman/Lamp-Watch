const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Data & notifications
  notify:             (title, body) => ipcRenderer.send('notify',          { title, body }),
  saveData:           (data)        => ipcRenderer.send('save-data',        data),

  // Settings
  loadSettings:       ()            => ipcRenderer.invoke('load-settings'),
  saveSettings:       (s)           => ipcRenderer.send('save-settings',    s),
  getStartup:         ()            => ipcRenderer.invoke('get-startup'),

  // External notifications
  testSlack:          (url)         => ipcRenderer.invoke('test-slack',     url),
  testResend:         (cfg)         => ipcRenderer.invoke('test-resend',    cfg),

  // DMX Master Timer
  getNICs:            ()            => ipcRenderer.invoke('get-nics'),
  getDMXState:        ()            => ipcRenderer.invoke('get-dmx-state'),
  resetFixtureTimer:  (id)          => ipcRenderer.send('reset-fixture-timer', id),

  // DMX live events (main → renderer)
  onDMXStateChange: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('dmx-state-change', handler);
    return () => ipcRenderer.removeListener('dmx-state-change', handler);
  },
  onDMXTick: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('dmx-tick', handler);
    return () => ipcRenderer.removeListener('dmx-tick', handler);
  },
});
