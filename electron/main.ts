import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import pty from 'node-pty'

type AuthToolKey = 'codex-cli' | 'kimi-cli'

type SessionRecord = {
  id: string
  name: string
  cwd: string
  authTool: AuthToolKey | null
  authProfile: string | null
  pinned: boolean
  createdAt: number
}

type SessionStatus = 'running' | 'idle' | 'closed'

type SessionState = {
  record: SessionRecord
  pty: pty.IPty | null
  status: SessionStatus
  idleMonitor: ReturnType<typeof setInterval> | null
  lastOutputAt: number
  lastRunningHintAt: number | null
  lastUserEditAt: number | null
}

type SessionSnapshot = SessionRecord & {
  live: boolean
  status: SessionStatus
}

type AppSnapshot = {
  sessions: SessionSnapshot[]
  selectedSessionId: string | null
  authCatalog: {
    key: AuthToolKey
    label: string
    profiles: string[]
  }[]
  settings: {
    authBaseRoot: string
  }
}

type PersistedState = {
  sessions: SessionRecord[]
  selectedSessionId: string | null
}

type PersistedSettings = {
  authBaseRoot?: string
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rendererHtml = path.join(__dirname, '..', 'index.html')
const preloadPath = path.join(__dirname, 'preload.js')
const appIconPath = path.join(__dirname, '..', 'assets', 'app.ico')

const defaultCols = 140
const defaultRows = 40
const IDLE_TIMEOUT_MS = 8000
const RUNNING_HINT_HOLD_MS = 12000
const USER_EDIT_ECHO_HOLD_MS = 800
const IDLE_MONITOR_INTERVAL_MS = 400

let mainWindow: BrowserWindow | null = null
let statePath = ''
let settingsPath = ''
let initialized = false
let appQuitting = false
let selectedSessionId: string | null = null
let authBaseRoot = path.join(os.homedir(), '.multiauth')
const sessionStates = new Map<string, SessionState>()

const CLI_AUTH_REGISTRY: Record<
  AuthToolKey,
  {
    label: string
    envVar: string
  }
> = {
  'codex-cli': {
    label: 'Codex CLI',
    envVar: 'CODEX_HOME',
  },
  'kimi-cli': {
    label: 'Kimi CLI',
    envVar: 'KIMI_SHARE_DIR',
  },
}

function resolveCwd(input: string) {
  const resolved = path.resolve(input.trim() || process.cwd())
  const stat = fs.statSync(resolved, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) {
    throw new Error(`Project path is invalid: ${resolved}`)
  }
  return resolved
}

function shellName() {
  return process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || 'bash'
}

function defaultSessionRecord() {
  const cwd = resolveCwd(process.cwd())
  return buildSessionRecord(cwd, path.basename(cwd) || cwd, null, null)
}

function normalizeAuthProfile(input?: string | null) {
  const trimmed = input?.trim()
  return trimmed ? trimmed : null
}

function normalizeAuthTool(input?: string | null) {
  const trimmed = input?.trim() ?? null
  if (!trimmed) {
    return null
  }
  return Object.prototype.hasOwnProperty.call(CLI_AUTH_REGISTRY, trimmed) ? (trimmed as AuthToolKey) : null
}

function validateAuthTool(input?: string | null) {
  const normalized = normalizeAuthTool(input)
  if (!input || !String(input).trim()) {
    return null
  }
  if (!normalized) {
    throw new Error(`Unsupported auth tool: ${input}`)
  }
  return normalized
}

function validateAuthProfile(input?: string | null) {
  const normalized = normalizeAuthProfile(input)
  if (!normalized) {
    return null
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error('Auth profile can only use letters, numbers, dashes, and underscores')
  }
  return normalized
}

function authProfileBaseDir(authTool: AuthToolKey, authProfile: string) {
  return path.join(authToolRootDir(authTool), authProfile)
}

function authProfileDir(authTool: AuthToolKey, authProfile: string) {
  return path.join(authProfileBaseDir(authTool, authProfile), 'data')
}

function authToolRootDir(authTool: AuthToolKey) {
  return path.join(authBaseRoot, authTool)
}

function listAuthProfiles(authTool: AuthToolKey) {
  const rootDir = authToolRootDir(authTool)
  if (!fs.existsSync(rootDir)) {
    return []
  }

  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
}

function listAuthCatalog() {
  return Object.entries(CLI_AUTH_REGISTRY).map(([key, adapter]) => ({
    key: key as AuthToolKey,
    label: adapter.label,
    profiles: listAuthProfiles(key as AuthToolKey),
  }))
}

function createAuthProfile(authTool: AuthToolKey, authProfile: string) {
  const profileDir = authProfileBaseDir(authTool, authProfile)
  const dataDir = authProfileDir(authTool, authProfile)
  if (fs.existsSync(profileDir)) {
    throw new Error(`Profile already exists: ${authProfile}`)
  }
  fs.mkdirSync(dataDir, { recursive: true })
}

function deleteAuthProfile(authTool: AuthToolKey, authProfile: string) {
  const inUse = [...sessionStates.values()].some(
    (state) => state.record.authTool === authTool && state.record.authProfile === authProfile,
  )
  if (inUse) {
    throw new Error('Profile is currently used by an existing terminal')
  }
  fs.rmSync(authProfileBaseDir(authTool, authProfile), { recursive: true, force: true })
}

function buildSessionRecord(
  cwd: string,
  name?: string,
  authTool?: string | null,
  authProfile?: string | null,
): SessionRecord {
  const trimmedName = name?.trim()
  const normalizedAuthTool = validateAuthTool(authTool)
  return {
    id: randomUUID(),
    name: trimmedName || path.basename(cwd) || cwd,
    cwd,
    authTool: normalizedAuthTool,
    authProfile: validateAuthProfile(authProfile),
    pinned: false,
    createdAt: Date.now(),
  }
}

function createSessionState(record: SessionRecord): SessionState {
  const now = Date.now()
  return {
    record,
    pty: null,
    status: 'closed',
    idleMonitor: null,
    lastOutputAt: now,
    lastRunningHintAt: null,
    lastUserEditAt: null,
  }
}

function sortedStates() {
  return [...sessionStates.values()].sort((left, right) => {
    if (left.record.pinned !== right.record.pinned) {
      return Number(right.record.pinned) - Number(left.record.pinned)
    }
    if (left.record.createdAt !== right.record.createdAt) {
      return left.record.createdAt - right.record.createdAt
    }
    return left.record.name.localeCompare(right.record.name)
  })
}

function snapshot(): AppSnapshot {
  return {
    sessions: sortedStates().map(({ record, pty: livePty, status }) => ({
      ...record,
      live: Boolean(livePty),
      status: livePty ? status : 'closed',
    })),
    selectedSessionId,
    authCatalog: listAuthCatalog(),
    settings: {
      authBaseRoot,
    },
  }
}

function persistState() {
  const payload: PersistedState = {
    sessions: sortedStates().map(({ record }) => record),
    selectedSessionId,
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf8')
}

function persistSettings() {
  const payload: PersistedSettings = {
    authBaseRoot,
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(payload, null, 2), 'utf8')
}

function canSendToRenderer() {
  return Boolean(
    !appQuitting &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed(),
  )
}

function sendToRenderer(channel: string, payload: unknown) {
  if (!canSendToRenderer()) {
    return false
  }

  try {
    mainWindow!.webContents.send(channel, payload)
    return true
  } catch {
    return false
  }
}

function broadcastSessions() {
  sendToRenderer('sessions-updated', snapshot())
}

function ensureSelectedSession() {
  if (selectedSessionId && sessionStates.has(selectedSessionId)) {
    return
  }
  selectedSessionId = sortedStates()[0]?.record.id ?? null
}

function updateStatus(state: SessionState, nextStatus: SessionStatus) {
  if (state.status === nextStatus) {
    return
  }
  state.status = nextStatus
  broadcastSessions()
}

function stripAnsi(input: string) {
  return input.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

function looksLikePrompt(chunk: string) {
  const promptPattern =
    /^(?:PS [^\r\n>]+>|[^\r\n]{0,120}[>$#%]|.*\d+% left .*|.*(?:gpt|o\d|claude).*(?:left|\/model to change).*)\s?$/i
  const lines = stripAnsi(chunk)
    .split(/\r?\n/)
    .reverse()
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  const lastLine = lines[0]
  if (!lastLine) {
    return false
  }

  return (
    promptPattern.test(lastLine) ||
    lastLine.startsWith('>') ||
    lastLine.startsWith('\u203a') ||
    lastLine.startsWith('\u276f')
  )
}

function looksLikeRunningHint(chunk: string) {
  return stripAnsi(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .some(
      (line) =>
        line.includes('working (') ||
        line.includes('esc to interrupt') ||
        line.includes('ctrl+c to stop') ||
        line.includes('ctrl-c to stop') ||
        line.includes('thinking') ||
        line.includes('streaming'),
    )
}

function hasRecentRunningHint(state: SessionState) {
  return state.lastRunningHintAt !== null && Date.now() - state.lastRunningHintAt < RUNNING_HINT_HOLD_MS
}

function hasRecentUserEdit(state: SessionState) {
  return state.lastUserEditAt !== null && Date.now() - state.lastUserEditAt < USER_EDIT_ECHO_HOLD_MS
}

function isUserEditInput(input: string) {
  return !input.includes('\r') && !input.includes('\n')
}

function clearIdleMonitor(state: SessionState) {
  if (state.idleMonitor) {
    clearInterval(state.idleMonitor)
    state.idleMonitor = null
  }
}

function startIdleMonitor(state: SessionState) {
  clearIdleMonitor(state)
  state.idleMonitor = setInterval(() => {
    if (!state.pty) {
      return
    }
    if (hasRecentRunningHint(state)) {
      return
    }
    if (Date.now() - state.lastOutputAt >= IDLE_TIMEOUT_MS) {
      updateStatus(state, 'idle')
    }
  }, IDLE_MONITOR_INTERVAL_MS)
}

function spawnSession(state: SessionState) {
  if (state.pty) {
    return
  }

  const env = { ...process.env }
  if (state.record.authTool && state.record.authProfile) {
    const adapter = CLI_AUTH_REGISTRY[state.record.authTool]
    const profileDir = authProfileDir(state.record.authTool, state.record.authProfile)
    fs.mkdirSync(profileDir, { recursive: true })
    env[adapter.envVar] = profileDir
  }

  const livePty = pty.spawn(shellName(), [], {
    name: 'xterm-256color',
    cols: defaultCols,
    rows: defaultRows,
    cwd: state.record.cwd,
    env,
  })

  state.pty = livePty
  state.lastOutputAt = Date.now()
  state.lastRunningHintAt = null
  state.lastUserEditAt = null
  updateStatus(state, 'running')

  livePty.onData((chunk) => {
    state.lastOutputAt = Date.now()
    if (looksLikeRunningHint(chunk)) {
      state.lastRunningHintAt = Date.now()
    }

    sendToRenderer('terminal-output', {
      sessionId: state.record.id,
      chunk,
    })

    const promptDetected = looksLikePrompt(chunk)
    const runningHintActive = hasRecentRunningHint(state)
    const userEditEchoActive = hasRecentUserEdit(state)

    if (promptDetected && !runningHintActive) {
      updateStatus(state, 'idle')
    } else if (userEditEchoActive) {
      return
    } else {
      updateStatus(state, 'running')
    }
  })

  livePty.onExit(({ exitCode }) => {
    clearIdleMonitor(state)
    state.pty = null
    state.lastRunningHintAt = null
    state.lastUserEditAt = null
    updateStatus(state, 'closed')
    sendToRenderer('terminal-output', {
      sessionId: state.record.id,
      chunk: `\r\n[terminal exited: ${exitCode}]\r\n`,
    })
    broadcastSessions()
  })

  startIdleMonitor(state)
}

function killSession(state: SessionState) {
  if (!state.pty) {
    return
  }
  clearIdleMonitor(state)
  try {
    state.pty.kill()
  } catch {
    // Best effort cleanup for child PTY.
  }
  state.pty = null
  state.lastRunningHintAt = null
  state.lastUserEditAt = null
  state.status = 'closed'
}

function ensureInitialized() {
  if (initialized) {
    return snapshot()
  }

  initialized = true
  for (const state of sortedStates()) {
    spawnSession(state)
  }
  ensureSelectedSession()
  broadcastSessions()
  return snapshot()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    title: 'Terminal Fleet',
    icon: appIconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow.loadFile(rendererHtml)
}

function loadPersistedSettings() {
  if (!fs.existsSync(settingsPath)) {
    return
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as PersistedSettings
    if (parsed.authBaseRoot?.trim()) {
      authBaseRoot = resolveCwd(parsed.authBaseRoot)
    }
  } catch {
    authBaseRoot = path.join(os.homedir(), '.multiauth')
  }
}

function loadPersistedState() {
  if (!fs.existsSync(statePath)) {
    const fallback = defaultSessionRecord()
    sessionStates.set(fallback.id, createSessionState(fallback))
    selectedSessionId = fallback.id
    return
  }

  try {
    const raw = fs.readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw) as PersistedState
    const records = Array.isArray(parsed.sessions) ? parsed.sessions : []
    for (const record of records) {
      if (!record?.id || !record.cwd || !record.name) {
        continue
      }
      let authProfile: string | null = null
      let authTool: AuthToolKey | null = null
      try {
        authProfile = validateAuthProfile(record.authProfile)
      } catch {
        authProfile = null
      }
      try {
        authTool = validateAuthTool(record.authTool ?? (authProfile ? 'codex-cli' : null))
      } catch {
        authTool = null
      }
      sessionStates.set(
        record.id,
        createSessionState({
          id: record.id,
          cwd: resolveCwd(record.cwd),
          name: record.name,
          authTool,
          authProfile,
          pinned: Boolean(record.pinned),
          createdAt: Number(record.createdAt) || Date.now(),
        }),
      )
    }
    selectedSessionId = parsed.selectedSessionId ?? null
  } catch {
    sessionStates.clear()
  }

  if (sessionStates.size === 0) {
    const fallback = defaultSessionRecord()
    sessionStates.set(fallback.id, createSessionState(fallback))
    selectedSessionId = fallback.id
  }
  ensureSelectedSession()
}

app.whenReady().then(async () => {
  app.setName('Terminal Fleet')
  statePath = path.join(app.getPath('userData'), 'sessions.json')
  settingsPath = path.join(app.getPath('userData'), 'settings.json')
  loadPersistedSettings()
  loadPersistedState()
  await createWindow()
})

ipcMain.handle('app:init', () => ensureInitialized())

ipcMain.handle('dialog:pick-directory', async () => {
  const targetWindow = mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined
  const result = await dialog.showOpenDialog(targetWindow, {
    title: 'Select Project Folder',
    properties: ['openDirectory'],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return resolveCwd(result.filePaths[0])
})

ipcMain.handle('settings:update-auth-root', (_event, inputPath: string) => {
  authBaseRoot = resolveCwd(inputPath)
  persistSettings()
  broadcastSessions()
  return snapshot().settings
})

ipcMain.handle('settings:reset-auth-root', () => {
  authBaseRoot = path.join(os.homedir(), '.multiauth')
  persistSettings()
  broadcastSessions()
  return snapshot().settings
})

ipcMain.handle(
  'sessions:create',
  (_event, inputCwd: string, inputName?: string, authTool?: string | null, authProfile?: string | null) => {
    const cwd = resolveCwd(inputCwd)
    const record = buildSessionRecord(cwd, inputName, authTool, authProfile)
    const state = createSessionState(record)
    sessionStates.set(record.id, state)
    selectedSessionId = record.id
    if (initialized) {
      spawnSession(state)
    }
    persistState()
    broadcastSessions()
    return record.id
  },
)

ipcMain.handle('auth:create-profile', (_event, authToolInput: string, profileInput: string) => {
  const authTool = validateAuthTool(authToolInput)
  const authProfile = validateAuthProfile(profileInput)
  if (!authTool || !authProfile) {
    throw new Error('Both auth tool and profile are required')
  }
  createAuthProfile(authTool, authProfile)
  broadcastSessions()
  return true
})

ipcMain.handle('auth:delete-profile', (_event, authToolInput: string, profileInput: string) => {
  const authTool = validateAuthTool(authToolInput)
  const authProfile = validateAuthProfile(profileInput)
  if (!authTool || !authProfile) {
    throw new Error('Both auth tool and profile are required')
  }
  deleteAuthProfile(authTool, authProfile)
  broadcastSessions()
  return true
})

ipcMain.handle('sessions:rename', (_event, sessionId: string, nextName: string) => {
  const state = sessionStates.get(sessionId)
  if (!state) {
    return false
  }
  const trimmed = nextName.trim()
  if (!trimmed) {
    return false
  }
  state.record.name = trimmed
  persistState()
  broadcastSessions()
  return true
})

ipcMain.handle('sessions:toggle-pin', (_event, sessionId: string) => {
  const state = sessionStates.get(sessionId)
  if (!state) {
    return false
  }
  state.record.pinned = !state.record.pinned
  persistState()
  broadcastSessions()
  return true
})

ipcMain.handle('sessions:remove', (_event, sessionId: string) => {
  const state = sessionStates.get(sessionId)
  if (!state) {
    return false
  }
  killSession(state)
  sessionStates.delete(sessionId)
  if (sessionStates.size === 0) {
    const fallback = defaultSessionRecord()
    const fallbackState = createSessionState(fallback)
    sessionStates.set(fallback.id, fallbackState)
    if (initialized) {
      spawnSession(fallbackState)
    }
  }
  ensureSelectedSession()
  persistState()
  broadcastSessions()
  return true
})

ipcMain.handle('sessions:reopen', (_event, sessionId: string) => {
  const state = sessionStates.get(sessionId)
  if (!state) {
    return false
  }
  spawnSession(state)
  selectedSessionId = sessionId
  persistState()
  broadcastSessions()
  return true
})

ipcMain.handle('sessions:select', (_event, sessionId: string) => {
  if (!sessionStates.has(sessionId)) {
    return false
  }
  selectedSessionId = sessionId
  persistState()
  broadcastSessions()
  return true
})

ipcMain.handle('terminal:input', (_event, sessionId: string, input: string) => {
  const state = sessionStates.get(sessionId)
  if (!state?.pty) {
    return
  }
  if (isUserEditInput(input)) {
    state.lastUserEditAt = Date.now()
  }
  state.pty.write(input)
})

ipcMain.handle('terminal:resize', (_event, sessionId: string, cols: number, rows: number) => {
  sessionStates.get(sessionId)?.pty?.resize(Math.max(cols, 20), Math.max(rows, 2))
})

app.on('before-quit', () => {
  appQuitting = true
  for (const state of sessionStates.values()) {
    killSession(state)
  }
  persistState()
})

app.on('window-all-closed', () => {
  app.quit()
})
