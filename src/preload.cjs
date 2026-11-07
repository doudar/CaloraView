const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['devices', 'connect', 'disconnect', 'snapshot', 'recordStart', 'recordStop', 'logStart', 'logStop', 'replay', 'shutter', 'settings', 'openOutput', 'state']);
contextBridge.exposeInMainWorld('caloraview', {
  invoke(action, payload) {
    if (!actions.has(action)) return Promise.reject(new Error('Unsupported action.'));
    return ipcRenderer.invoke('caloraview:action', action, payload);
  },
  onFrame(callback) {
    const listener = (_event, frame) => { callback(frame); ipcRenderer.send('caloraview:frame-ack'); };
    ipcRenderer.on('caloraview:frame', listener);
    return () => ipcRenderer.removeListener('caloraview:frame', listener);
  },
  onStatus(callback) {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('caloraview:status', listener);
    return () => ipcRenderer.removeListener('caloraview:status', listener);
  }
});
