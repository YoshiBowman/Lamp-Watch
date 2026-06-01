const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  notify:        (title, body) => ipcRenderer.send('notify',         { title, body }),
  saveData:      (data)        => ipcRenderer.send('save-data',      data),
  loadSettings:  ()            => ipcRenderer.invoke('load-settings'),
  saveSettings:  (s)           => ipcRenderer.send('save-settings',  s),
  getStartup:    ()            => ipcRenderer.invoke('get-startup'),
  testSlack:     (url)         => ipcRenderer.invoke('test-slack',   url),
  testResend:    (cfg)         => ipcRenderer.invoke('test-resend',  cfg),
});
