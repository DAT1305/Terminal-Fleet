import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('terminalApi', {
  init: () => ipcRenderer.invoke('app:init'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  createSession: (cwd: string, name?: string, authTool?: string | null, authProfile?: string | null) =>
    ipcRenderer.invoke('sessions:create', cwd, name, authTool, authProfile),
  createAuthProfile: (authTool: string, profile: string) =>
    ipcRenderer.invoke('auth:create-profile', authTool, profile),
  deleteAuthProfile: (authTool: string, profile: string) =>
    ipcRenderer.invoke('auth:delete-profile', authTool, profile),
  updateAuthRoot: (inputPath: string) => ipcRenderer.invoke('settings:update-auth-root', inputPath),
  resetAuthRoot: () => ipcRenderer.invoke('settings:reset-auth-root'),
  renameSession: (sessionId: string, name: string) =>
    ipcRenderer.invoke('sessions:rename', sessionId, name),
  togglePin: (sessionId: string) => ipcRenderer.invoke('sessions:toggle-pin', sessionId),
  removeSession: (sessionId: string) => ipcRenderer.invoke('sessions:remove', sessionId),
  reopenSession: (sessionId: string) => ipcRenderer.invoke('sessions:reopen', sessionId),
  selectSession: (sessionId: string) => ipcRenderer.invoke('sessions:select', sessionId),
  sendInput: (sessionId: string, input: string) => ipcRenderer.invoke('terminal:input', sessionId, input),
  resize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
  onOutput: (handler: (payload: { sessionId: string; chunk: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; chunk: string }) =>
      handler(payload)
    ipcRenderer.on('terminal-output', listener)
    return () => ipcRenderer.removeListener('terminal-output', listener)
  },
  onSessionsUpdated: (
    handler: (payload: { sessions: unknown[]; selectedSessionId: string | null }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { sessions: unknown[]; selectedSessionId: string | null },
    ) => handler(payload)
    ipcRenderer.on('sessions-updated', listener)
    return () => ipcRenderer.removeListener('sessions-updated', listener)
  },
})
