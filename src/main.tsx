import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

type AuthToolKey = 'codex-cli' | 'kimi-cli'

type AuthCatalogItem = {
  key: AuthToolKey
  label: string
  profiles: string[]
}

type SessionRecord = {
  id: string
  groupId: string
  name: string
  cwd: string
  authTool: AuthToolKey | null
  authProfile: string | null
  pinned: boolean
  createdAt: number
  live: boolean
  status: 'running' | 'idle' | 'closed'
}

type AppSnapshot = {
  sessions: SessionRecord[]
  selectedSessionId: string | null
  authCatalog: AuthCatalogItem[]
  settings: {
    authBaseRoot: string
  }
}

type ContextMenuState = {
  sessionId: string
  x: number
  y: number
} | null

type RenameState = {
  sessionId: string
  value: string
} | null

type ProfileModalState = {
  mode: 'create' | 'delete'
  authTool: AuthToolKey
  value: string
} | null

type SettingsModalState = {
  authBaseRoot: string
} | null

type LiveTerminal = {
  terminal: Terminal
  fitAddon: FitAddon
  disposeInput: () => void
}

type SessionGroup = {
  id: string
  root: SessionRecord
  sessions: SessionRecord[]
}

type SplitDragState = {
  groupId: string
  index: number
  startX: number
  startRatios: number[]
  width: number
}

declare global {
  interface Window {
    terminalApi: {
      init: () => Promise<AppSnapshot>
      pickDirectory: () => Promise<string | null>
      createSession: (
        cwd: string,
        name?: string,
        authTool?: AuthToolKey | null,
        authProfile?: string | null,
      ) => Promise<string>
      createAuthProfile: (authTool: AuthToolKey, profile: string) => Promise<boolean>
      deleteAuthProfile: (authTool: AuthToolKey, profile: string) => Promise<boolean>
      updateAuthRoot: (inputPath: string) => Promise<{ authBaseRoot: string }>
      resetAuthRoot: () => Promise<{ authBaseRoot: string }>
      readClipboardText: () => Promise<string>
      writeClipboardText: (value: string) => Promise<void>
      renameSession: (sessionId: string, name: string) => Promise<boolean>
      togglePin: (sessionId: string) => Promise<boolean>
      splitSession: (sessionId: string) => Promise<string | null>
      removeSession: (sessionId: string) => Promise<boolean>
      reopenSession: (sessionId: string) => Promise<boolean>
      selectSession: (sessionId: string) => Promise<boolean>
      sendInput: (sessionId: string, input: string) => Promise<void>
      resize: (sessionId: string, cols: number, rows: number) => Promise<void>
      onOutput: (handler: (payload: { sessionId: string; chunk: string }) => void) => () => void
      onSessionsUpdated: (handler: (payload: AppSnapshot) => void) => () => void
    }
  }
}

function App() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [authCatalog, setAuthCatalog] = useState<AuthCatalogItem[]>([])
  const [authBaseRoot, setAuthBaseRoot] = useState('')
  const [cwdInput, setCwdInput] = useState('')
  const [nameInput, setNameInput] = useState('')
  const [authToolInput, setAuthToolInput] = useState<AuthToolKey | ''>('')
  const [authProfileInput, setAuthProfileInput] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [renameState, setRenameState] = useState<RenameState>(null)
  const [profileModal, setProfileModal] = useState<ProfileModalState>(null)
  const [settingsModal, setSettingsModal] = useState<SettingsModalState>(null)
  const [authMenuOpen, setAuthMenuOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [paneRatiosByGroup, setPaneRatiosByGroup] = useState<Record<string, number[]>>({})

  const hostRefs = useRef(new Map<string, HTMLDivElement>())
  const terminalRefs = useRef(new Map<string, LiveTerminal>())
  const outputBuffers = useRef(new Map<string, string[]>())
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const splitDragRef = useRef<SplitDragState | null>(null)

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  )

  const sessionGroups = useMemo<SessionGroup[]>(() => {
    const grouped = new Map<string, SessionRecord[]>()
    for (const session of sessions) {
      const groupId = session.groupId || session.id
      const current = grouped.get(groupId) ?? []
      current.push(session)
      grouped.set(groupId, current)
    }

    return [...grouped.entries()].map(([groupId, groupedSessions]) => {
      const root =
        groupedSessions.find((session) => session.id === groupId) ??
        groupedSessions[0]

      return {
        id: groupId,
        root,
        sessions: groupedSessions,
      }
    })
  }, [sessions])

  const selectedGroup = useMemo(() => {
    if (!selectedSession) {
      return null
    }
    return sessionGroups.find((group) => group.id === selectedSession.groupId) ?? null
  }, [selectedSession, sessionGroups])

  const selectedSidebarSession = selectedGroup?.root ?? selectedSession

  const contextSession = useMemo(
    () => sessions.find((session) => session.id === contextMenu?.sessionId) ?? null,
    [contextMenu, sessions],
  )

  const renameSession = useMemo(
    () => sessions.find((session) => session.id === renameState?.sessionId) ?? null,
    [renameState, sessions],
  )

  const selectedAuthCatalog = useMemo(
    () => authCatalog.find((item) => item.key === authToolInput) ?? null,
    [authCatalog, authToolInput],
  )

  const authToolLabelByKey = useMemo(
    () =>
      Object.fromEntries(authCatalog.map((item) => [item.key, item.label])) as Record<AuthToolKey, string>,
    [authCatalog],
  )

  const authProfileOptions = useMemo(
    () => selectedAuthCatalog?.profiles ?? [],
    [selectedAuthCatalog],
  )

  const ensureTerminal = (sessionId: string) => {
    const host = hostRefs.current.get(sessionId)
    if (!host) {
      return
    }

    const existingLiveTerminal = terminalRefs.current.get(sessionId)
    if (existingLiveTerminal) {
      const currentElement = existingLiveTerminal.terminal.element
      if (currentElement && currentElement.parentElement !== host) {
        host.replaceChildren(currentElement)
        existingLiveTerminal.fitAddon.fit()
      }
      return
    }

    const terminal = new Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#0f0f0f',
        foreground: '#ececec',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    fitAddon.fit()

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') {
        return true
      }

      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
        const selectedText = terminal.getSelection()
        if (!selectedText) {
          return true
        }

        void window.terminalApi.writeClipboardText(selectedText)
        terminal.clearSelection()
        return false
      }

      const wantsPaste =
        ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v') ||
        (!event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && event.key === 'Insert')

      if (wantsPaste) {
        void window.terminalApi.readClipboardText().then((pastedText) => {
          if (!pastedText) {
            return
          }
          terminal.focus()
          void window.terminalApi.sendInput(sessionId, pastedText)
        })
        return false
      }

      return true
    })

    const inputDisposable = terminal.onData((data) => {
      void window.terminalApi.sendInput(sessionId, data)
    })

    terminalRefs.current.set(sessionId, {
      terminal,
      fitAddon,
      disposeInput: () => inputDisposable.dispose(),
    })

    const bufferedOutput = outputBuffers.current.get(sessionId)
    if (bufferedOutput?.length) {
      for (const chunk of bufferedOutput) {
        terminal.write(chunk)
      }
      outputBuffers.current.delete(sessionId)
    }
  }

  const authLabel = (authTool: AuthToolKey | null, authProfile: string | null) => {
    if (!authTool) {
      return 'Default environment'
    }
    const toolLabel = authToolLabelByKey[authTool] ?? authTool
    return `${toolLabel} / ${authProfile ?? 'Default'}`
  }

  const groupStatus = (group: SessionGroup | null) => {
    if (!group) {
      return 'closed'
    }
    if (group.sessions.some((session) => session.status === 'running')) {
      return 'running'
    }
    if (group.sessions.some((session) => session.live && session.status === 'idle')) {
      return 'idle'
    }
    return 'closed'
  }

  const paneLabel = (group: SessionGroup, session: SessionRecord) => {
    const index = group.sessions.findIndex((item) => item.id === session.id)
    return index >= 0 ? `Pane ${index + 1}` : session.name
  }

  function normalizedPaneRatios(group: SessionGroup | null) {
    if (!group || group.sessions.length === 0) {
      return []
    }

    const stored = paneRatiosByGroup[group.id]
    const count = group.sessions.length
    const minShare = Math.min(0.1, 1 / Math.max(count * 2, 2))

    if (!stored?.length) {
      return Array.from({ length: count }, () => 1 / count)
    }

    let ratios = [...stored]
    if (ratios.length < count) {
      const existingTotal = ratios.reduce((sum, value) => sum + value, 0)
      const remaining = Math.max(1 - existingTotal, minShare * (count - ratios.length))
      const addition = remaining / (count - ratios.length)
      ratios = ratios.concat(Array.from({ length: count - ratios.length }, () => addition))
    } else if (ratios.length > count) {
      ratios = ratios.slice(0, count)
    }

    const total = ratios.reduce((sum, value) => sum + value, 0) || 1
    return ratios.map((value) => value / total)
  }

  const currentPaneRatios = useMemo(() => normalizedPaneRatios(selectedGroup), [selectedGroup, paneRatiosByGroup])

  const openRename = (session: SessionRecord) => {
    setContextMenu(null)
    setRenameState({
      sessionId: session.id,
      value: session.name,
    })
  }

  const commitRename = async () => {
    if (!renameState || !renameSession) {
      setRenameState(null)
      return
    }

    const trimmed = renameState.value.trim()
    if (!trimmed || trimmed === renameSession.name) {
      setRenameState(null)
      return
    }

    await window.terminalApi.renameSession(renameSession.id, trimmed)
    setRenameState(null)
  }

  const handleRemove = async (session: SessionRecord) => {
    setContextMenu(null)
    setRenameState(null)
    if (!window.confirm(`Remove terminal "${session.name}"?`)) {
      return
    }
    await window.terminalApi.removeSession(session.id)
  }

  const handleReopen = async (session: SessionRecord) => {
    setContextMenu(null)
    await window.terminalApi.reopenSession(session.id)
  }

  const handleSplit = async (session: SessionRecord) => {
    setContextMenu(null)
    setErrorMessage('')
    try {
      await window.terminalApi.splitSession(session.id)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to split terminal')
    }
  }

  const handleStartPaneResize = (event: React.PointerEvent<HTMLDivElement>, index: number) => {
    if (!selectedGroup || !workspaceRef.current) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    splitDragRef.current = {
      groupId: selectedGroup.id,
      index,
      startX: event.clientX,
      startRatios: currentPaneRatios,
      width: workspaceRef.current.getBoundingClientRect().width,
    }
  }

  const handleCreateSession = async () => {
    if (!cwdInput.trim()) {
      setErrorMessage('Project path is required')
      return
    }
    setErrorMessage('')
    setIsCreating(true)
    try {
      await window.terminalApi.createSession(cwdInput, nameInput, authToolInput || null, authProfileInput || null)
      setNameInput('')
      setAuthMenuOpen(false)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create terminal')
    } finally {
      setIsCreating(false)
    }
  }

  const handleBrowseDirectory = async () => {
    setErrorMessage('')
    try {
      const picked = await window.terminalApi.pickDirectory()
      if (!picked) {
        return
      }
      setCwdInput(picked)
      if (!nameInput.trim()) {
        const segments = picked.split(/[\\/]/).filter(Boolean)
        setNameInput(segments.at(-1) ?? '')
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to open folder picker')
    }
  }

  const handleBrowseAuthRoot = async () => {
    setErrorMessage('')
    try {
      const picked = await window.terminalApi.pickDirectory()
      if (!picked) {
        return
      }
      setSettingsModal((current) =>
        current
          ? {
              ...current,
              authBaseRoot: picked,
            }
          : current,
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to open folder picker')
    }
  }

  const handleUseSelected = () => {
    if (!selectedSession) {
      return
    }
    setErrorMessage('')
    setCwdInput(selectedSession.cwd)
    setAuthToolInput(selectedSession.authTool ?? '')
    setAuthProfileInput(selectedSession.authProfile ?? '')
  }

  const handleClearLaunchBar = () => {
    setErrorMessage('')
    setNameInput('')
    setAuthToolInput('')
    setAuthProfileInput('')
    setCwdInput(selectedSession?.cwd ?? '')
  }

  const openCreateProfile = () => {
    if (!authToolInput) {
      setErrorMessage('Choose a CLI auth tool first')
      return
    }
    setErrorMessage('')
    setAuthMenuOpen(false)
    setProfileModal({
      mode: 'create',
      authTool: authToolInput,
      value: '',
    })
  }

  const handleDeleteProfile = async () => {
    if (!authToolInput || !authProfileInput) {
      return
    }
    setErrorMessage('')
    setAuthMenuOpen(false)
    setProfileModal({
      mode: 'delete',
      authTool: authToolInput,
      value: authProfileInput,
    })
  }

  const openSettings = () => {
    setContextMenu(null)
    setAuthMenuOpen(false)
    setSettingsModal({
      authBaseRoot,
    })
  }

  const commitSettings = async () => {
    if (!settingsModal) {
      return
    }
    try {
      const nextSettings = settingsModal.authBaseRoot.trim()
        ? await window.terminalApi.updateAuthRoot(settingsModal.authBaseRoot)
        : await window.terminalApi.resetAuthRoot()
      setAuthBaseRoot(nextSettings.authBaseRoot)
      setSettingsModal(null)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to update settings')
    }
  }

  const resetSettingsRoot = async () => {
    try {
      const nextSettings = await window.terminalApi.resetAuthRoot()
      setAuthBaseRoot(nextSettings.authBaseRoot)
      setSettingsModal({
        authBaseRoot: nextSettings.authBaseRoot,
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to reset auth root')
    }
  }

  const commitProfileModal = async () => {
    if (!profileModal) {
      return
    }

    try {
      if (profileModal.mode === 'create') {
        await window.terminalApi.createAuthProfile(profileModal.authTool, profileModal.value)
        setAuthToolInput(profileModal.authTool)
        setAuthProfileInput(profileModal.value)
      } else {
        await window.terminalApi.deleteAuthProfile(profileModal.authTool, profileModal.value)
        if (authToolInput === profileModal.authTool && authProfileInput === profileModal.value) {
          setAuthProfileInput('')
        }
      }
      setProfileModal(null)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Profile update failed')
    }
  }

  useEffect(() => {
    const unlistenOutput = window.terminalApi.onOutput(({ sessionId, chunk }) => {
      const liveTerminal = terminalRefs.current.get(sessionId)
      if (liveTerminal) {
        liveTerminal.terminal.write(chunk)
        return
      }

      const buffered = outputBuffers.current.get(sessionId) ?? []
      buffered.push(chunk)
      outputBuffers.current.set(sessionId, buffered)
    })

    const unlistenSessions = window.terminalApi.onSessionsUpdated((snapshot) => {
      setSessions(snapshot.sessions)
      setSelectedSessionId(snapshot.selectedSessionId ?? snapshot.sessions[0]?.id ?? null)
      setAuthCatalog(snapshot.authCatalog ?? [])
      setAuthBaseRoot(snapshot.settings?.authBaseRoot ?? '')
    })

    void window.terminalApi.init().then((snapshot) => {
      setSessions(snapshot.sessions)
      setSelectedSessionId(snapshot.selectedSessionId ?? snapshot.sessions[0]?.id ?? null)
      setAuthCatalog(snapshot.authCatalog ?? [])
      setAuthBaseRoot(snapshot.settings?.authBaseRoot ?? '')
      setCwdInput(snapshot.sessions[0]?.cwd ?? '')
      setAuthToolInput(snapshot.sessions[0]?.authTool ?? '')
      setAuthProfileInput(snapshot.sessions[0]?.authProfile ?? '')
    })

    return () => {
      unlistenOutput()
      unlistenSessions()
      for (const liveTerminal of terminalRefs.current.values()) {
        liveTerminal.disposeInput()
        liveTerminal.terminal.dispose()
      }
      terminalRefs.current.clear()
    }
  }, [])

  useEffect(() => {
    const handleGlobalPointer = () => {
      setContextMenu(null)
      setAuthMenuOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null)
        setRenameState(null)
        setSettingsModal(null)
        setAuthMenuOpen(false)
        return
      }

      if (event.key !== 'F2' || !selectedSidebarSession) {
        return
      }

      const activeElement = document.activeElement
      if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
        return
      }

      event.preventDefault()
      openRename(selectedSidebarSession)
    }

    window.addEventListener('pointerdown', handleGlobalPointer)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handleGlobalPointer)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectedSidebarSession])

  useEffect(() => {
    for (const session of sessions) {
      ensureTerminal(session.id)
    }

    const activeIds = new Set(sessions.map((session) => session.id))
    for (const [sessionId, liveTerminal] of terminalRefs.current) {
      if (activeIds.has(sessionId)) {
        continue
      }
      liveTerminal.disposeInput()
      liveTerminal.terminal.dispose()
      terminalRefs.current.delete(sessionId)
      hostRefs.current.delete(sessionId)
      outputBuffers.current.delete(sessionId)
    }
  }, [sessions])

  useEffect(() => {
    setPaneRatiosByGroup((current) => {
      const next: Record<string, number[]> = {}
      for (const group of sessionGroups) {
        next[group.id] = normalizedPaneRatios(group)
      }
      return next
    })
  }, [sessionGroups])

  useEffect(() => {
    if (!selectedGroup || selectedGroup.sessions.length === 0) {
      return
    }

    const resizeVisiblePanes = () => {
      for (const session of selectedGroup.sessions) {
        const liveTerminal = terminalRefs.current.get(session.id)
        if (!liveTerminal) {
          continue
        }
        liveTerminal.fitAddon.fit()
        void window.terminalApi.resize(session.id, liveTerminal.terminal.cols, liveTerminal.terminal.rows)
        if (session.id === selectedSessionId) {
          liveTerminal.terminal.focus()
        }
      }
    }

    requestAnimationFrame(resizeVisiblePanes)

    const observer = new ResizeObserver(() => {
      resizeVisiblePanes()
    })

    if (workspaceRef.current) {
      observer.observe(workspaceRef.current)
    }

    return () => observer.disconnect()
  }, [selectedGroup, selectedSessionId, sessions, currentPaneRatios])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = splitDragRef.current
      if (!drag || drag.width <= 0) {
        return
      }

      const minShare = 0.16
      const deltaRatio = (event.clientX - drag.startX) / drag.width
      const nextRatios = [...drag.startRatios]
      const left = nextRatios[drag.index] ?? 0
      const right = nextRatios[drag.index + 1] ?? 0
      const combined = left + right

      let nextLeft = left + deltaRatio
      let nextRight = right - deltaRatio

      if (nextLeft < minShare) {
        nextLeft = minShare
        nextRight = combined - minShare
      } else if (nextRight < minShare) {
        nextRight = minShare
        nextLeft = combined - minShare
      }

      nextRatios[drag.index] = nextLeft
      nextRatios[drag.index + 1] = nextRight

      setPaneRatiosByGroup((current) => ({
        ...current,
        [drag.groupId]: nextRatios,
      }))
    }

    const handlePointerUp = () => {
      splitDragRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [])

  useEffect(() => {
    if (!renameState?.sessionId) {
      return
    }
    requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }, [renameState?.sessionId])

  useEffect(() => {
    if (!authToolInput) {
      if (authProfileInput) {
        setAuthProfileInput('')
      }
      return
    }
    if (authProfileInput && !authProfileOptions.includes(authProfileInput)) {
      setAuthProfileInput('')
    }
  }, [authToolInput, authProfileInput, authProfileOptions])

  return (
    <div className="app-shell">
      <header className="launchbar">
        <div className="launchbar-main">
          <div className="launchbar-head">
            <div className="launchbar-branding">
              <div className="brand-mark" aria-hidden="true">
                <span className="brand-mark-panel brand-mark-panel-top" />
                <span className="brand-mark-panel brand-mark-panel-middle" />
                <span className="brand-mark-panel brand-mark-panel-bottom" />
                <span className="brand-mark-cursor" />
              </div>
              <div>
              <div className="launchbar-title">New Terminal</div>
              <div className="launchbar-subtitle">Start a new shell in any project folder.</div>
              </div>
            </div>
            <div className="launchbar-meta">
              <span className="hint-chip">Press Enter to create</span>
              <span className="hint-chip">{authLabel(authToolInput || null, authProfileInput || null)}</span>
              <span className="hint-chip">Root: {authBaseRoot || 'Default'}</span>
            </div>
          </div>

          <div className="launchbar-grid">
            <label className="launchbar-field">
              <span className="field-label">Project path</span>
              <div className="field-row">
                <input
                  className="field"
                  value={cwdInput}
                  onChange={(event) => setCwdInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void handleCreateSession()
                    }
                  }}
                  placeholder="Example: E:\\projects\\client-a"
                />
                <button className="ghost-button compact-button" onClick={() => void handleBrowseDirectory()}>
                  Browse
                </button>
              </div>
            </label>

            <label className="launchbar-field">
              <span className="field-label">Tab name</span>
              <input
                className="field"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void handleCreateSession()
                  }
                }}
                placeholder="Leave empty to use the folder name"
              />
            </label>
          </div>
        </div>

        <div className="launchbar-actions">
          <button className="ghost-button" onClick={openSettings}>
            Settings
          </button>
          <div className="menu-anchor">
            <button
              className={`ghost-button${authMenuOpen ? ' active-button' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                setContextMenu(null)
                setAuthMenuOpen((current) => !current)
              }}
            >
              Auth
            </button>
            {authMenuOpen ? (
              <div
                className="auth-menu"
                onPointerDown={(event) => {
                  event.stopPropagation()
                }}
              >
                <div className="auth-menu-section">
                  <div className="auth-menu-label">CLI tool</div>
                  <select
                    className="field"
                    value={authToolInput}
                    onChange={(event) => setAuthToolInput(event.target.value as AuthToolKey | '')}
                  >
                    <option value="">Default environment</option>
                    {authCatalog.map((tool) => (
                      <option key={tool.key} value={tool.key}>
                        {tool.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="auth-menu-section">
                  <div className="auth-menu-label">Profile</div>
                  <select
                    className="field"
                    value={authProfileInput}
                    disabled={!authToolInput}
                    onChange={(event) => setAuthProfileInput(event.target.value)}
                  >
                    <option value="">{authToolInput ? 'Default profile' : 'Choose a CLI auth first'}</option>
                    {authProfileOptions.map((profile) => (
                      <option key={profile} value={profile}>
                        {profile}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="auth-menu-actions">
                  <button className="ghost-button compact-button" onClick={openCreateProfile}>
                    New
                  </button>
                  <button
                    className="ghost-button compact-button"
                    disabled={!authToolInput || !authProfileInput}
                    onClick={() => void handleDeleteProfile()}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <button className="ghost-button" disabled={!selectedSession} onClick={handleUseSelected}>
            Use Selected
          </button>
          <button className="ghost-button" onClick={handleClearLaunchBar}>
            Clear
          </button>
          <button
            className="primary-button launch-button"
            disabled={isCreating || !cwdInput.trim()}
            onClick={() => void handleCreateSession()}
          >
            {isCreating ? 'Creating...' : 'New Terminal'}
          </button>
        </div>
      </header>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <main className="content">
        <aside className="sidebar">
          <div className="sidebar-header">
            <span>Terminals</span>
            <span>{sessionGroups.length}</span>
          </div>

          <div className="session-list">
            {sessionGroups.map((group) => (
              <button
                key={group.id}
                className={`session-card${selectedGroup?.id === group.id ? ' selected' : ''}`}
                onClick={() => {
                  setContextMenu(null)
                  setSelectedSessionId(group.root.id)
                  void window.terminalApi.selectSession(group.root.id)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setSelectedSessionId(group.root.id)
                  void window.terminalApi.selectSession(group.root.id)
                  setContextMenu({
                    sessionId: group.root.id,
                    x: event.clientX,
                    y: event.clientY,
                  })
                }}
              >
                <div className="session-main">
                  <div className="session-title">
                    <span>{group.root.name}</span>
                    <span className={`status-badge status-${groupStatus(group)}`}>
                      {groupStatus(group)}
                    </span>
                  </div>
                  <div className="session-cwd">{group.root.cwd}</div>
                  <div className="session-meta">
                    Auth: {authLabel(group.root.authTool, group.root.authProfile)}
                  </div>
                  {group.sessions.length > 1 ? <div className="session-splits">{group.sessions.length} panes</div> : null}
                </div>
                <div className="session-actions">
                  <span
                    className={`pin-badge${group.root.pinned ? ' active' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setContextMenu(null)
                      void window.terminalApi.togglePin(group.root.id)
                    }}
                  >
                    {group.root.pinned ? 'Pinned' : 'Pin'}
                  </span>
                  <span
                    className="action-link"
                    onClick={(event) => {
                      event.stopPropagation()
                      openRename(group.root)
                    }}
                  >
                    Rename
                  </span>
                  <span
                    className="action-link danger"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleRemove(group.root)
                    }}
                  >
                    Remove
                  </span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="workspace">
          <div className="workspace-header">
            <div>
              <div className="workspace-title">{selectedSidebarSession?.name ?? 'No terminal selected'}</div>
              <div className="workspace-subtitle">{selectedSidebarSession?.cwd ?? 'Create a terminal to start'}</div>
              {selectedSidebarSession ? (
                <div className="workspace-meta">
                  Auth: {authLabel(selectedSidebarSession.authTool, selectedSidebarSession.authProfile)}
                  {selectedGroup && selectedGroup.sessions.length > 1 ? ` • ${selectedGroup.sessions.length} panes` : ''}
                </div>
              ) : null}
            </div>
            <div className="workspace-actions">
              {selectedGroup ? (
                <span className={`status-badge status-${groupStatus(selectedGroup)}`}>
                  {groupStatus(selectedGroup)}
                </span>
              ) : null}
              {selectedSession ? (
                <button className="ghost-button" onClick={() => void handleSplit(selectedSession)}>
                  Split
                </button>
              ) : null}
              {selectedSession && !selectedSession.live ? (
                <button
                  className="ghost-button"
                  onClick={() => {
                    void handleReopen(selectedSession)
                  }}
                >
                  Reopen
                </button>
              ) : null}
            </div>
          </div>

          <div className="workspace-body" ref={workspaceRef}>
            {selectedGroup?.sessions.map((session, index) => (
              <React.Fragment key={session.id}>
                <div
                  className={`terminal-pane${selectedSessionId === session.id ? ' active' : ''}`}
                  style={{ flexBasis: `${(currentPaneRatios[index] ?? 1 / selectedGroup.sessions.length) * 100}%` }}
                  onClick={() => {
                    setSelectedSessionId(session.id)
                    void window.terminalApi.selectSession(session.id)
                    terminalRefs.current.get(session.id)?.terminal.focus()
                  }}
                >
                  <div className="terminal-pane-header">
                    <div className="terminal-pane-title">
                      <span>{selectedGroup ? paneLabel(selectedGroup, session) : session.name}</span>
                      <span className="terminal-pane-path">{session.cwd}</span>
                    </div>
                    <div className="terminal-pane-actions">
                      <span className={`status-badge status-${session.status}`}>{session.status}</span>
                      <button
                        className="icon-button"
                        title="Split pane"
                        aria-label="Split pane"
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleSplit(session)
                        }}
                      >
                        <span className="icon-split" aria-hidden="true">
                          <span />
                          <span />
                        </span>
                      </button>
                      {!session.live ? (
                        <button
                          className="ghost-button compact-button"
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleReopen(session)
                          }}
                        >
                          Reopen
                        </button>
                      ) : null}
                      {selectedGroup && selectedGroup.sessions.length > 1 ? (
                        <button
                          className="icon-button danger-icon-button"
                          title="Close pane"
                          aria-label="Close pane"
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleRemove(session)
                          }}
                        >
                          <span className="icon-close" aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div
                    className="terminal-host visible split-host"
                    ref={(node) => {
                      if (node) {
                        hostRefs.current.set(session.id, node)
                        ensureTerminal(session.id)
                        return
                      }
                      hostRefs.current.delete(session.id)
                    }}
                  />
                </div>
                {selectedGroup && index < selectedGroup.sessions.length - 1 ? (
                  <div
                    className="pane-resizer"
                    onPointerDown={(event) => handleStartPaneResize(event, index)}
                  >
                    <span className="pane-resizer-handle" />
                  </div>
                ) : null}
              </React.Fragment>
            )) ?? null}
          </div>
        </section>
      </main>

      {contextMenu && contextSession ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            className="context-item"
            onClick={() => {
              void window.terminalApi.togglePin(contextSession.id)
              setContextMenu(null)
            }}
          >
            {contextSession.pinned ? 'Unpin from top' : 'Pin to top'}
          </button>
          <button
            className="context-item"
            onClick={() => {
              openRename(contextSession)
            }}
          >
            Rename
          </button>
          <button
            className="context-item"
            onClick={() => {
              void handleSplit(contextSession)
            }}
          >
            Split terminal
          </button>
          {!contextSession.live ? (
            <button
              className="context-item"
              onClick={() => {
                void handleReopen(contextSession)
              }}
            >
              Reopen terminal
            </button>
          ) : null}
          <button
            className="context-item danger"
            onClick={() => {
              void handleRemove(contextSession)
            }}
          >
            Remove
          </button>
        </div>
      ) : null}

      {profileModal ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            setProfileModal(null)
          }}
        >
          <div
            className="modal-card"
            onMouseDown={(event) => {
              event.stopPropagation()
            }}
          >
            <div className="modal-title">
              {profileModal.mode === 'create' ? 'Create auth profile' : 'Delete auth profile'}
            </div>
            <div className="modal-subtitle">
              {authToolLabelByKey[profileModal.authTool] ?? profileModal.authTool}
            </div>
            {profileModal.mode === 'create' ? (
              <input
                className="field modal-input"
                value={profileModal.value}
                onChange={(event) =>
                  setProfileModal((current) =>
                    current
                      ? {
                          ...current,
                          value: event.target.value,
                        }
                      : current,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void commitProfileModal()
                  }
                }}
                placeholder="Profile name"
              />
            ) : (
              <div className="modal-copy">
                Delete profile <strong>{profileModal.value}</strong>? Stored auth data for this CLI profile
                will be removed.
              </div>
            )}
            <div className="modal-actions">
              <button
                className="ghost-button"
                onClick={() => {
                  setProfileModal(null)
                }}
              >
                Cancel
              </button>
              <button
                className="primary-button modal-save"
                onClick={() => {
                  void commitProfileModal()
                }}
              >
                {profileModal.mode === 'create' ? 'Create' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsModal ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            setSettingsModal(null)
          }}
        >
          <div
            className="modal-card"
            onMouseDown={(event) => {
              event.stopPropagation()
            }}
          >
            <div className="modal-title">Settings</div>
            <div className="modal-subtitle">Choose the root folder that stores shared CLI auth profiles.</div>
            <input
              className="field modal-input"
              value={settingsModal.authBaseRoot}
              onChange={(event) =>
                setSettingsModal((current) =>
                  current
                    ? {
                        ...current,
                        authBaseRoot: event.target.value,
                      }
                    : current,
                )
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitSettings()
                }
              }}
              placeholder="Example: C:\\Users\\you\\.multiauth"
            />
            <div className="modal-copy">Current tools read profiles from this root, for example `codex-cli` and `kimi-cli`.</div>
            <div className="modal-actions modal-actions-spread">
              <button
                className="ghost-button"
                onClick={() => void handleBrowseAuthRoot()}
              >
                Browse
              </button>
              <button className="ghost-button" onClick={() => void resetSettingsRoot()}>
                Reset Default
              </button>
              <div className="modal-actions">
                <button
                  className="ghost-button"
                  onClick={() => {
                    setSettingsModal(null)
                  }}
                >
                  Cancel
                </button>
                <button
                  className="primary-button modal-save"
                  onClick={() => {
                    void commitSettings()
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {renameState && renameSession ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            setRenameState(null)
          }}
        >
          <div
            className="modal-card"
            onMouseDown={(event) => {
              event.stopPropagation()
            }}
          >
            <div className="modal-title">Rename terminal</div>
            <div className="modal-subtitle">{renameSession.cwd}</div>
            <input
              ref={renameInputRef}
              className="field modal-input"
              value={renameState.value}
              onChange={(event) =>
                setRenameState((current) =>
                  current
                    ? {
                        ...current,
                        value: event.target.value,
                      }
                    : current,
                )
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitRename()
                }
              }}
            />
            <div className="modal-actions">
              <button
                className="ghost-button"
                onClick={() => {
                  setRenameState(null)
                }}
              >
                Cancel
              </button>
              <button
                className="primary-button modal-save"
                onClick={() => {
                  void commitRename()
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
