import { useCallback, useEffect, useRef, useState } from 'react'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { TacticDocumentV1 } from '../domain/model/types'
import { useTacticStore } from '../editor/useTacticStore'
import {
  tacticLibrary,
  type TacticLibraryEntry,
  type TacticSnapshotSummary,
} from '../persistence/tacticLibrary'

const AUTOSAVE_DELAY_MS = 450

function downloadLibraryBackup(text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = `提瓦特战术库-${new Date().toISOString().slice(0, 10)}.teyvat-library.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

export function useTacticLibraryController() {
  const document = useTacticStore((state) => state.document)
  const openDocument = useTacticStore((state) => state.openDocument)
  const setNotice = useTacticStore((state) => state.setNotice)
  const [isOpen, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [entries, setEntries] = useState<TacticLibraryEntry[]>([])
  const activeIdRef = useRef<string | null>(null)
  const autosaveTimerRef = useRef<number | null>(null)
  const initializationRef = useRef<ReturnType<typeof tacticLibrary.initialize> | null>(null)

  const updateActiveId = useCallback((id: string) => {
    activeIdRef.current = id
    setActiveId(id)
  }, [])

  const refreshEntries = useCallback(async () => {
    const next = await tacticLibrary.list()
    setEntries(next)
    return next
  }, [])

  const reportError = useCallback((error: unknown, fallback: string) => {
    setNotice(error instanceof Error ? `${fallback}：${error.message}` : fallback)
  }, [setNotice])

  useEffect(() => {
    let cancelled = false
    if (typeof indexedDB === 'undefined') return
    initializationRef.current ??= tacticLibrary.initialize(useTacticStore.getState().document)
    void initializationRef.current.then((result) => {
      if (cancelled) return
      updateActiveId(result.activeId)
      setEntries(result.entries)
      setReady(true)
      openDocument(result.document, '')
    }).catch((error: unknown) => {
      if (!cancelled) reportError(error, '本地历史记录不可用')
    })
    return () => { cancelled = true }
  }, [openDocument, reportError, updateActiveId])

  useEffect(() => {
    if (!ready || !activeId) return
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      const savingId = activeIdRef.current
      if (!savingId) return
      void tacticLibrary.save(savingId, document).then((changed) => {
        if (changed) return refreshEntries()
      }).catch((error: unknown) => reportError(error, '自动保存历史版本失败'))
    }, AUTOSAVE_DELAY_MS)
    return () => {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
  }, [activeId, document, ready, refreshEntries, reportError])

  const flushCurrent = useCallback(async () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    const id = activeIdRef.current
    if (ready && id) await tacticLibrary.save(id, useTacticStore.getState().document)
  }, [ready])

  const createNew = useCallback(async () => {
    setBusy(true)
    try {
      await flushCurrent()
      const result = await tacticLibrary.create(createDefaultDocument())
      updateActiveId(result.activeId)
      setEntries(result.entries)
      openDocument(result.document, '已新建战术。')
      setOpen(false)
    } catch (error) {
      reportError(error, '新建战术失败')
    } finally {
      setBusy(false)
    }
  }, [flushCurrent, openDocument, reportError, updateActiveId])

  const importDocument = useCallback(async (imported: TacticDocumentV1) => {
    if (!ready) {
      openDocument(imported, '战术文件已导入。')
      return
    }
    setBusy(true)
    try {
      await flushCurrent()
      const result = await tacticLibrary.create(imported)
      updateActiveId(result.activeId)
      setEntries(result.entries)
      openDocument(result.document, '战术文件已导入并加入“我的战术”。')
    } catch (error) {
      reportError(error, '导入战术失败')
    } finally {
      setBusy(false)
    }
  }, [flushCurrent, openDocument, ready, reportError, updateActiveId])

  const openTactic = useCallback(async (id: string) => {
    if (id === activeIdRef.current) return
    setBusy(true)
    try {
      await flushCurrent()
      const next = await tacticLibrary.open(id)
      if (!next) throw new Error('该战术无法读取。')
      updateActiveId(id)
      openDocument(next)
      await refreshEntries()
      setOpen(false)
    } catch (error) {
      reportError(error, '打开战术失败')
    } finally {
      setBusy(false)
    }
  }, [flushCurrent, openDocument, refreshEntries, reportError, updateActiveId])

  const duplicateTactic = useCallback(async (id: string) => {
    setBusy(true)
    try {
      await flushCurrent()
      const copy = await tacticLibrary.duplicate(id)
      if (!copy) throw new Error('该战术无法读取。')
      await refreshEntries()
      setNotice(`已复制“${copy.title}”。`)
    } catch (error) {
      reportError(error, '复制战术失败')
    } finally {
      setBusy(false)
    }
  }, [flushCurrent, refreshEntries, reportError, setNotice])

  const deleteTactic = useCallback(async (id: string) => {
    setBusy(true)
    try {
      if (id === activeIdRef.current) await flushCurrent()
      const result = await tacticLibrary.remove(id, createDefaultDocument())
      const activeChanged = result.activeId !== activeIdRef.current
      updateActiveId(result.activeId)
      if (activeChanged) openDocument(result.document, '已删除战术并打开最近的战术。')
      else setNotice('已删除战术。')
      await refreshEntries()
    } catch (error) {
      reportError(error, '删除战术失败')
    } finally {
      setBusy(false)
    }
  }, [flushCurrent, openDocument, refreshEntries, reportError, setNotice, updateActiveId])

  const loadSnapshots = useCallback(async (id: string): Promise<TacticSnapshotSummary[]> => {
    try {
      return await tacticLibrary.snapshots(id)
    } catch (error) {
      reportError(error, '读取历史版本失败')
      return []
    }
  }, [reportError])

  const restoreSnapshot = useCallback(async (id: string, snapshotId: string) => {
    setBusy(true)
    try {
      await flushCurrent()
      const restored = await tacticLibrary.restore(id, snapshotId)
      if (!restored) throw new Error('该历史版本无法读取。')
      updateActiveId(id)
      openDocument(restored, '已恢复历史版本。')
      await refreshEntries()
      setOpen(false)
    } catch (error) {
      reportError(error, '恢复历史版本失败')
    } finally {
      setBusy(false)
    }
  }, [flushCurrent, openDocument, refreshEntries, reportError, updateActiveId])

  const backupAll = useCallback(async () => {
    setBusy(true)
    try {
      await flushCurrent()
      downloadLibraryBackup(await tacticLibrary.exportBackup())
      setNotice('全部战术已备份。')
    } catch (error) {
      reportError(error, '备份战术库失败')
    } finally {
      setBusy(false)
    }
  }, [flushCurrent, reportError, setNotice])

  const restoreBackup = useCallback(async (file: File) => {
    setBusy(true)
    try {
      const result = await tacticLibrary.importBackup(await file.text())
      updateActiveId(result.activeId)
      setEntries(result.entries)
      openDocument(result.document, '战术库备份已恢复。')
      setOpen(false)
    } catch (error) {
      reportError(error, '恢复战术库失败')
    } finally {
      setBusy(false)
    }
  }, [openDocument, reportError, updateActiveId])

  return {
    isOpen,
    setOpen,
    ready,
    busy,
    activeId,
    entries,
    createNew,
    importDocument,
    openTactic,
    duplicateTactic,
    deleteTactic,
    loadSnapshots,
    restoreSnapshot,
    backupAll,
    restoreBackup,
  }
}

export type TacticLibraryController = ReturnType<typeof useTacticLibraryController>
