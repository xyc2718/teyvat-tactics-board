import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import {
  createTacticLibrary,
  MAX_TACTIC_SNAPSHOTS,
  type StoredTacticRecord,
  type TacticLibraryBackend,
} from './tacticLibrary'

class MemoryBackend implements TacticLibraryBackend {
  records = new Map<string, StoredTacticRecord>()
  activeId: string | null = null

  async getAllTactics() { return structuredClone([...this.records.values()]) }
  async getTactic(id: string) { return structuredClone(this.records.get(id)) }
  async putTactic(record: StoredTacticRecord) { this.records.set(record.id, structuredClone(record)) }
  async deleteTactic(id: string) { this.records.delete(id) }
  async getActiveId() { return this.activeId }
  async setActiveId(id: string) { this.activeId = id }
  async replaceAll(records: StoredTacticRecord[], activeId: string) {
    this.records = new Map(records.map((record) => [record.id, structuredClone(record)]))
    this.activeId = activeId
  }
}

function deterministicLibrary(backend = new MemoryBackend()) {
  let tick = 0
  let id = 0
  const library = createTacticLibrary(
    backend,
    () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    (prefix) => `${prefix}-${++id}`,
  )
  return { backend, library }
}

describe('tactic library', () => {
  it('migrates the current draft into the first local tactic', async () => {
    const { backend, library } = deterministicLibrary()
    const draft = createDefaultDocument()
    draft.meta.title = '旧草稿'

    const initialized = await library.initialize(draft)

    expect(initialized.document.meta.title).toBe('旧草稿')
    expect(initialized.entries).toEqual([expect.objectContaining({ title: '旧草稿', snapshotCount: 1 })])
    expect(await backend.getActiveId()).toBe(initialized.activeId)
  })

  it('stores only changed documents and caps automatic history at twenty versions', async () => {
    const { backend, library } = deterministicLibrary()
    const document = createDefaultDocument()
    const initialized = await library.initialize(document)

    expect(await library.save(initialized.activeId, document)).toBe(false)
    for (let index = 1; index <= 25; index += 1) {
      document.meta.notes = `编辑 ${index}`
      expect(await library.save(initialized.activeId, document)).toBe(true)
    }

    const record = await backend.getTactic(initialized.activeId)
    expect(record?.snapshots).toHaveLength(MAX_TACTIC_SNAPSHOTS)
    expect((await library.open(initialized.activeId))?.meta.notes).toBe('编辑 25')
  })

  it('duplicates tactics without switching the active tactic and keeps another tactic active when deleting', async () => {
    const { backend, library } = deterministicLibrary()
    const first = await library.initialize(createDefaultDocument())
    const copy = await library.duplicate(first.activeId)

    expect(copy?.title).toBe('未命名战术 副本')
    expect(await backend.getActiveId()).toBe(first.activeId)

    await library.remove(copy!.id, createDefaultDocument())
    expect(await backend.getActiveId()).toBe(first.activeId)
    expect(await library.list()).toHaveLength(1)
  })

  it('restores an earlier snapshot as the current tactic', async () => {
    const { library } = deterministicLibrary()
    const document = createDefaultDocument()
    const initialized = await library.initialize(document)
    document.meta.title = '修改后'
    await library.save(initialized.activeId, document)
    const history = await library.snapshots(initialized.activeId)

    const restored = await library.restore(initialized.activeId, history.at(-1)!.id)

    expect(restored?.meta.title).toBe('未命名战术')
    expect((await library.open(initialized.activeId))?.meta.title).toBe('未命名战术')
  })

  it('exports and restores a complete browser-local backup', async () => {
    const source = deterministicLibrary()
    const first = await source.library.initialize(createDefaultDocument())
    const secondDocument = createDefaultDocument()
    secondDocument.meta.title = '第二套战术'
    await source.library.create(secondDocument)
    const backup = await source.library.exportBackup()

    const target = deterministicLibrary()
    const restored = await target.library.importBackup(backup)

    expect(restored.entries.map((entry) => entry.title).sort()).toEqual(['未命名战术', '第二套战术'])
    expect(restored.activeId).not.toBe(first.activeId)
    expect(await target.backend.getActiveId()).toBe(restored.activeId)
  })
})
