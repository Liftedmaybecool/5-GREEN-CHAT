const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, minimal API to the renderer (petnan.html)
contextBridge.exposeInMainWorld('electronAPI', {

  // App info
  getVersion:  () => ipcRenderer.invoke('get-app-version'),
  getAppPath:  () => ipcRenderer.invoke('get-app-path'),

  // File saving (export conversation)
  saveConversation: async (text) => {
    const { filePath, canceled } = await ipcRenderer.invoke('show-save-dialog', {
      title:       'Save Conversation',
      defaultPath: `PetnanAI-conversation-${Date.now()}.txt`,
      filters:     [
        { name: 'Text File', extensions: ['txt'] },
        { name: 'Markdown',  extensions: ['md'] },
      ],
    });
    if (canceled || !filePath) return { ok: false };
    return ipcRenderer.invoke('save-file', { filePath, data: text });
  },

  // Platform info
  platform: process.platform,

  // Is running inside Electron?
  isElectron: true,
});
