import type { TacticDocumentV1 } from '../domain/model/types'
import { parseTactic, serializeTactic } from './tacticFile'

const DATABASE_NAME = 'teyvat-tactics-library'
const DATABASE_VERSION = 1
const TACTICS_STORE = 'tactics'
const META_STORE = 'meta'
const ACTIVE_TACTIC_KEY = 'active-tactic-id'

export const MAX_TACTIC_SNAPSHOTS = 20

export interface TacticSnapshotSummary {
  id: string
  savedAt: string
  title: string
  actionCount: number
}

export interface TacticLibraryEntry {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  actionCount: number
  snapshotCount: number
}

interface StoredSnapshot extends TacticSnapshotSummary {
  documentJson: string
}

export interface StoredTacticRecord {
  id: string
  createdAt: string
  updatedAt: string
  documentJson: string
  snapshots: StoredSnapshot[]
}

interface MetaRecord {
  key: string
  value: string
}

export interface TacticLibraryBackend {
  getAllTactics(): Promise<StoredTacticRecord[]>
  getTactic(id: string): Promise<StoredTacticRecord | undefined>
  putTactic(record: StoredTacticRecord): Promise<void>
  deleteTactic(id: string): Promise<void>
  getActiveId(): Promise<string | null>
  setActiveId(id: string): Promise<void>
  replaceAll(records: StoredTacticRecord[], activeId: string): Promise<void>
}

export interface TacticLibraryInitialization {
  activeId: string
  document: TacticDocumentV1
  entries: TacticLibraryEntry[]
}

export interface DeleteTacticResult {
  activeId: string
  document: TacticDocumentV1
}

export interface LibraryBackupV1 {
  type: 'teyvat-tactic-library'
  schemaVersion: 1
  exportedAt: string
  activeId: string
  tactics: StoredTacticRecord[]
}

type Clock = () => string
type IdFactory = (prefix: string) => string

function defaultId(prefix: string): string {
  const suffix = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${suffix}`
}

function parseStoredDocument(text: string): TacticDocumentV1 | null {
  const parsed = parseTactic(text)
  return parsed.ok ? parsed.document : null
}

function documentSignature(document: TacticDocumentV1): string {
  return JSON.stringify({ ...document, meta: { ...document.meta, updatedAt: '' } })
}

function entryFromRecord(record: StoredTacticRecord): TacticLibraryEntry | null {
  const document = parseStoredDocument(record.documentJson)
  if (!document) return null
  return {
    id: record.id,
    title: document.meta.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    actionCount: document.actions.length,
    snapshotCount: record.snapshots.length,
  }
}

function sortedEntries(records: StoredTacticRecord[]): TacticLibraryEntry[] {
  return records
    .map(entryFromRecord)
    .filter((entry): entry is TacticLibraryEntry => entry !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function snapshotFromDocument(document: TacticDocumentV1, savedAt: string, id: string): StoredSnapshot {
  const documentJson = serializeTactic(document)
  const normalized = parseStoredDocument(documentJson) ?? document
  return {
    id,
    savedAt,
    title: normalized.meta.title,
    actionCount: normalized.actions.length,
    documentJson,
  }
}

function recordFromDocument(document: TacticDocumentV1, id: string, now: string, snapshotId: string): StoredTacticRecord {
  const snapshot = snapshotFromDocument(document, now, snapshotId)
  return {
    id,
    createdAt: now,
    updatedAt: now,
    documentJson: snapshot.documentJson,
    snapshots: [snapshot],
  }
}

function isStoredRecord(value: unknown): value is StoredTacticRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<StoredTacticRecord>
  return typeof record.id === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && typeof record.documentJson === 'string'
    && Array.isArray(record.snapshots)
}

function isStoredSnapshot(value: unknown): value is StoredSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<StoredSnapshot>
  return typeof snapshot.id === 'string'
    && typeof snapshot.savedAt === 'string'
    && typeof snapshot.title === 'string'
    && typeof snapshot.actionCount === 'number'
    && typeof snapshot.documentJson === 'string'
    && parseStoredDocument(snapshot.documentJson) !== null
}

export function createTacticLibrary(
  backend: TacticLibraryBackend,
  clock: Clock = () => new Date().toISOString(),
  makeId: IdFactory = defaultId,
) {
  async function list(): Promise<TacticLibraryEntry[]> {
    return sortedEntries(await backend.getAllTactics())
  }

  async function create(document: TacticDocumentV1): Promise<TacticLibraryInitialization> {
    const now = clock()
    const id = makeId('tactic')
    const record = recordFromDocument(document, id, now, makeId('snapshot'))
    await backend.putTactic(record)
    await backend.setActiveId(id)
    return { activeId: id, document: parseStoredDocument(record.documentJson) ?? document, entries: await list() }
  }

  async function initialize(fallbackDocument: TacticDocumentV1): Promise<TacticLibraryInitialization> {
    const records = await backend.getAllTactics()
    const valid = records.filter((record) => entryFromRecord(record) !== null)
    if (valid.length === 0) return create(fallbackDocument)

    const storedActiveId = await backend.getActiveId()
    const active = valid.find((record) => record.id === storedActiveId)
      ?? [...valid].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!
    await backend.setActiveId(active.id)
    return {
      activeId: active.id,
      document: parseStoredDocument(active.documentJson) ?? fallbackDocument,
      entries: sortedEntries(valid),
    }
  }

  async function save(id: string, document: TacticDocumentV1): Promise<boolean> {
    const record = await backend.getTactic(id)
    if (!record) return false
    const storedDocument = parseStoredDocument(record.documentJson)
    if (storedDocument && documentSignature(storedDocument) === documentSignature(document)) return false

    const now = clock()
    const snapshot = snapshotFromDocument(document, now, makeId('snapshot'))
    await backend.putTactic({
      ...record,
      updatedAt: now,
      documentJson: snapshot.documentJson,
      snapshots: [...record.snapshots, snapshot].slice(-MAX_TACTIC_SNAPSHOTS),
    })
    return true
  }

  async function open(id: string): Promise<TacticDocumentV1 | null> {
    const record = await backend.getTactic(id)
    if (!record) return null
    const document = parseStoredDocument(record.documentJson)
    if (!document) return null
    await backend.setActiveId(id)
    return document
  }

  async function duplicate(id: string): Promise<TacticLibraryEntry | null> {
    const record = await backend.getTactic(id)
    const document = record ? parseStoredDocument(record.documentJson) : null
    if (!document) return null
    document.meta.title = `${document.meta.title || '未命名战术'} 副本`
    const now = clock()
    const copy = recordFromDocument(document, makeId('tactic'), now, makeId('snapshot'))
    await backend.putTactic(copy)
    return entryFromRecord(copy)
  }

  async function remove(id: string, fallbackDocument: TacticDocumentV1): Promise<DeleteTacticResult> {
    const currentActiveId = await backend.getActiveId()
    await backend.deleteTactic(id)
    const records = (await backend.getAllTactics()).filter((record) => entryFromRecord(record) !== null)
    if (records.length === 0) {
      const created = await create(fallbackDocument)
      return { activeId: created.activeId, document: created.document }
    }
    const next = records.find((record) => record.id === currentActiveId)
      ?? [...records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!
    await backend.setActiveId(next.id)
    return { activeId: next.id, document: parseStoredDocument(next.documentJson) ?? fallbackDocument }
  }

  async function snapshots(id: string): Promise<TacticSnapshotSummary[]> {
    const record = await backend.getTactic(id)
    return record
      ? [...record.snapshots].reverse().map(({ documentJson: _documentJson, ...summary }) => summary)
      : []
  }

  async function restore(id: string, snapshotId: string): Promise<TacticDocumentV1 | null> {
    const record = await backend.getTactic(id)
    const snapshot = record?.snapshots.find((candidate) => candidate.id === snapshotId)
    const document = snapshot ? parseStoredDocument(snapshot.documentJson) : null
    if (!record || !document) return null

    const now = clock()
    const restoredSnapshot = snapshotFromDocument(document, now, makeId('snapshot'))
    await backend.putTactic({
      ...record,
      updatedAt: now,
      documentJson: restoredSnapshot.documentJson,
      snapshots: [...record.snapshots, restoredSnapshot].slice(-MAX_TACTIC_SNAPSHOTS),
    })
    await backend.setActiveId(id)
    return document
  }

  async function exportBackup(): Promise<string> {
    const records = (await backend.getAllTactics()).filter((record) => entryFromRecord(record) !== null)
    const activeId = await backend.getActiveId() ?? records[0]?.id ?? ''
    const backup: LibraryBackupV1 = {
      type: 'teyvat-tactic-library',
      schemaVersion: 1,
      exportedAt: clock(),
      activeId,
      tactics: records,
    }
    return JSON.stringify(backup, null, 2)
  }

  async function importBackup(text: string): Promise<TacticLibraryInitialization> {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error('无法解析备份文件。')
    }
    if (!raw || typeof raw !== 'object') throw new Error('备份文件结构无效。')
    const backup = raw as Partial<LibraryBackupV1>
    if (backup.type !== 'teyvat-tactic-library' || backup.schemaVersion !== 1 || !Array.isArray(backup.tactics)) {
      throw new Error('这不是受支持的战术库备份。')
    }
    const recordsById = new Map(backup.tactics
      .filter(isStoredRecord)
      .filter((record) => entryFromRecord(record) !== null)
      .map((record) => [record.id, {
        ...record,
        snapshots: record.snapshots.filter(isStoredSnapshot).slice(-MAX_TACTIC_SNAPSHOTS),
      }] as const))
    const records = [...recordsById.values()]
    if (records.length === 0) throw new Error('备份中没有可恢复的战术。')
    const active = records.find((record) => record.id === backup.activeId) ?? records[0]!
    await backend.replaceAll(records, active.id)
    return {
      activeId: active.id,
      document: parseStoredDocument(active.documentJson)!,
      entries: sortedEntries(records),
    }
  }

  return { initialize, list, create, save, open, duplicate, remove, snapshots, restore, exportBackup, importBackup }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败。'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已取消。'))
  })
}

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('当前浏览器不支持本地战术库。'))
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(TACTICS_STORE)) database.createObjectStore(TACTICS_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      databasePromise = null
      reject(request.error ?? new Error('无法打开本地战术库。'))
    }
  })
  return databasePromise
}

export const indexedDbTacticLibraryBackend: TacticLibraryBackend = {
  async getAllTactics() {
    const database = await openDatabase()
    return requestResult(database.transaction(TACTICS_STORE).objectStore(TACTICS_STORE).getAll())
  },
  async getTactic(id) {
    const database = await openDatabase()
    return requestResult(database.transaction(TACTICS_STORE).objectStore(TACTICS_STORE).get(id))
  },
  async putTactic(record) {
    const database = await openDatabase()
    const transaction = database.transaction(TACTICS_STORE, 'readwrite')
    transaction.objectStore(TACTICS_STORE).put(record)
    await transactionDone(transaction)
  },
  async deleteTactic(id) {
    const database = await openDatabase()
    const transaction = database.transaction(TACTICS_STORE, 'readwrite')
    transaction.objectStore(TACTICS_STORE).delete(id)
    await transactionDone(transaction)
  },
  async getActiveId() {
    const database = await openDatabase()
    const record = await requestResult<MetaRecord | undefined>(database.transaction(META_STORE).objectStore(META_STORE).get(ACTIVE_TACTIC_KEY))
    return record?.value ?? null
  },
  async setActiveId(id) {
    const database = await openDatabase()
    const transaction = database.transaction(META_STORE, 'readwrite')
    transaction.objectStore(META_STORE).put({ key: ACTIVE_TACTIC_KEY, value: id } satisfies MetaRecord)
    await transactionDone(transaction)
  },
  async replaceAll(records, activeId) {
    const database = await openDatabase()
    const transaction = database.transaction([TACTICS_STORE, META_STORE], 'readwrite')
    const tactics = transaction.objectStore(TACTICS_STORE)
    tactics.clear()
    for (const record of records) tactics.put(record)
    transaction.objectStore(META_STORE).put({ key: ACTIVE_TACTIC_KEY, value: activeId } satisfies MetaRecord)
    await transactionDone(transaction)
  },
}

export const tacticLibrary = createTacticLibrary(indexedDbTacticLibraryBackend)
