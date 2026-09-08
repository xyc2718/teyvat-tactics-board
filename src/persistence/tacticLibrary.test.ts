import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import { parseTactic, serializeTactic } from './tacticFile'
import {
  createTacticLibrary,
  MAX_TACTIC_SNAPSHOTS,
  type LibraryBackupV1,
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
  it.each(['current', 'snapshot'] as const)('rejects malformed explicit Geo in a backup %s before replacing any library data', async (location) => {
    const source = deterministicLibrary()
    await source.library.initialize(createDefaultDocument())
    await source.library.create(createDefaultDocument())
    const backup = JSON.parse(await source.library.exportBackup()) as LibraryBackupV1
    const record = backup.tactics[1]!
    const invalid = createDefaultDocument()
    invalid.rulesSnapshot.roles.geo.shield = { radius: 0 }
    if (location === 'current') record.documentJson = serializeTactic(invalid)
    else record.snapshots[0]!.documentJson = serializeTactic(invalid)
    const destination = deterministicLibrary()
    const existing = createDefaultDocument()
    existing.meta.title = 'Existing library must survive'
    await destination.library.initialize(existing)
    const before = structuredClone(destination.backend.records)
    const activeBefore = destination.backend.activeId

    await expect(destination.library.importBackup(JSON.stringify(backup))).rejects.toThrow('未修改当前战术库')
    expect(destination.backend.records).toEqual(before)
    expect(destination.backend.activeId).toBe(activeBefore)
  })

  it('migrates legacy Geo defaults and preserves custom Geo through history, copies and full-library backups', async () => {
    const source = deterministicLibrary()
    const legacy = createDefaultDocument()
    legacy.rulesSnapshot.passing.ballSpeed = 8
    legacy.rulesSnapshot.roles.fire.q.maxDistance = 4
    legacy.rulesSnapshot.matchups.water.fire = null
    legacy.basicPlayerRoles = { 'blue-water': 'geo' }
    const expectedLegacy = structuredClone(legacy)
    Reflect.deleteProperty(legacy.rulesSnapshot.roles, 'geo')
    Reflect.deleteProperty(legacy.rulesSnapshot.matchups, 'geo')
    for (const row of Object.values(legacy.rulesSnapshot.matchups)) Reflect.deleteProperty(row, 'geo')
    const first = await source.library.initialize(legacy)
    expect((await source.library.open(first.activeId))?.rulesSnapshot).toEqual(expectedLegacy.rulesSnapshot)

    const custom = createDefaultDocument()
    custom.initialScene.players[0]!.role = 'geo'
    custom.stepMarkers[0]!.snapshot = structuredClone(custom.initialScene)
    custom.rulesSnapshot.roles.geo.shield = { radius: 1.7 }
    custom.rulesSnapshot.roles.geo.q.maxDistance = 3.2
    custom.rulesSnapshot.matchups.geo.fire = 0
    custom.rulesSnapshot.matchups.water.geo = null
    custom.basicPlayerRoles = { 'blue-water': 'electro' }
    const second = await source.library.create(custom)
    const originalRules = structuredClone(custom.rulesSnapshot)
    custom.meta.notes = 'Updated Geo tactic'
    custom.rulesSnapshot.roles.geo.shield.radius = 2
    await source.library.save(second.activeId, custom)
    const copy = await source.library.duplicate(second.activeId)
    const destination = deterministicLibrary()
    await destination.library.importBackup(await source.library.exportBackup())
    expect((await destination.library.open(first.activeId))?.rulesSnapshot).toEqual(expectedLegacy.rulesSnapshot)
    expect((await destination.library.open(first.activeId))?.basicPlayerRoles).toEqual(legacy.basicPlayerRoles)
    const restoredCopy = await destination.library.open(copy!.id)
    expect(restoredCopy?.rulesSnapshot).toEqual(custom.rulesSnapshot)
    expect(restoredCopy?.initialScene).toEqual(custom.initialScene)
    expect(restoredCopy?.basicPlayerRoles).toEqual(custom.basicPlayerRoles)
    const snapshots = await destination.library.snapshots(second.activeId)
    const restoredHistory = await destination.library.restore(second.activeId, snapshots.at(-1)!.id)
    expect(restoredHistory?.rulesSnapshot).toEqual(originalRules)
    const legacySnapshots = await destination.library.snapshots(first.activeId)
    expect((await destination.library.restore(first.activeId, legacySnapshots[0]!.id))?.rulesSnapshot).toEqual(expectedLegacy.rulesSnapshot)
  })

  it('preserves Q cooldown source identities in copies, snapshots and full-library backups', async () => {
    const { library } = deterministicLibrary()
    const document = createDefaultDocument()
    document.rulesSnapshot.roles.water.q.cooldown = 6
    document.actions = [
      { id: 'q-source', type: 'qMove', actorId: 'blue-water', startTime: 2, duration: 0,
        path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }] },
      { id: 'q-run', type: 'move', actorId: 'blue-water', startTime: 4, duration: 4,
        path: [{ x: 8, y: 4.7 }, { x: 12, y: 4.7 }], timingConstraint: { kind: 'qCooldown', sourceActionId: 'q-source' } },
    ]
    const initialized = await library.initialize(document)
    const originalActions = structuredClone(document.actions)
    document.meta.notes = 'Edited explanation'
    await library.save(initialized.activeId, document)
    const copy = await library.duplicate(initialized.activeId)
    expect(copy?.id).not.toBe(initialized.activeId)
    expect((await library.open(copy!.id))?.actions).toEqual(originalActions)
    const target = deterministicLibrary()
    await target.library.importBackup(await library.exportBackup())
    expect((await target.library.open(copy!.id))?.actions).toEqual(originalActions)
    const snapshots = await target.library.snapshots(initialized.activeId)
    expect((await target.library.restore(initialized.activeId, snapshots.at(-1)!.id))?.actions).toEqual(originalActions)
  })

  it('deduplicates reordered overrides whose distinct player IDs collate equally', async () => {
    const { library } = deterministicLibrary()
    const composedId = '\u00e9'
    const decomposedId = 'e\u0301'
    const parsed = parseTactic(serializeTactic(createDefaultDocument())
      .replaceAll('blue-water', composedId).replaceAll('red-fire', decomposedId))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    const document = parsed.document
    document.basicPlayerRoles = { [composedId]: 'electro', [decomposedId]: 'geo' }
    const initialized = await library.initialize(document)
    document.basicPlayerRoles = { [decomposedId]: 'geo', [composedId]: 'electro' }
    expect(await library.save(initialized.activeId, document)).toBe(false)
    expect(await library.snapshots(initialized.activeId)).toHaveLength(1)
  })

  it('deduplicates unchanged saves when a legacy document gains or loses its first basic override', async () => {
    const { library } = deterministicLibrary()
    const initialized = await library.initialize(createDefaultDocument())
    const document = initialized.document
    document.basicPlayerRoles = { 'blue-water': 'electro' }
    expect(await library.save(initialized.activeId, document)).toBe(true)
    expect(await library.save(initialized.activeId, document)).toBe(false)
    expect(await library.save(initialized.activeId, (await library.open(initialized.activeId))!)).toBe(false)
    delete document.basicPlayerRoles
    expect(await library.save(initialized.activeId, document)).toBe(true)
    expect(await library.save(initialized.activeId, document)).toBe(false)
    expect(await library.snapshots(initialized.activeId)).toHaveLength(3)
  })

  it('retains basic roles in draft migration, semantic snapshots, copies and full-library backups', async () => {
    const source = deterministicLibrary()
    const document = createDefaultDocument()
    document.basicPlayerRoles = { 'blue-water': 'electro', 'red-fire': 'geo' }
    const first = await source.library.initialize(document)
    const oldRoles = structuredClone(document.basicPlayerRoles)
    expect(first.document.basicPlayerRoles).toEqual(oldRoles)
    document.basicPlayerRoles['blue-water'] = 'anemo'
    expect(await source.library.save(first.activeId, document)).toBe(true)
    expect(await source.library.save(first.activeId, document)).toBe(false)
    document.basicPlayerRoles = { 'red-fire': 'geo', 'blue-water': 'anemo' }
    expect(await source.library.save(first.activeId, document)).toBe(false)
    const copy = await source.library.duplicate(first.activeId)
    expect((await source.library.open(copy!.id))?.basicPlayerRoles).toEqual(document.basicPlayerRoles)

    const target = deterministicLibrary()
    await target.library.importBackup(await source.library.exportBackup())
    expect((await target.library.open(first.activeId))?.basicPlayerRoles).toEqual(document.basicPlayerRoles)
    const snapshots = await target.library.snapshots(first.activeId)
    expect(snapshots).toHaveLength(2)
    expect((await target.library.restore(first.activeId, snapshots.at(-1)!.id))?.basicPlayerRoles).toEqual(oldRoles)
    expect((await target.library.open(first.activeId))?.basicPlayerRoles).toEqual(oldRoles)
  })

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
