import type { TacticAction } from '../model/types'

/** Same-time ball events follow their semantic sources, not serialized array order.
 * Independent manual receptions retain their existing priority before releases. */
export function ballCausalRanks(actions: TacticAction[]): Map<string, number> {
  const byId = new Map(actions.map((action) => [action.id, action]))
  const ranks = new Map<string, number>()
  const visiting = new Set<string>()
  const rank = (id: string | null | undefined): number => {
    if (!id) return 0
    const cached = ranks.get(id)
    if (cached !== undefined) return cached
    // Imports reject cycles; diagnostic projection of intermediate drafts must
    // still terminate rather than recurse through an invalid reference chain.
    if (visiting.has(id)) return 0
    visiting.add(id)
    const action = byId.get(id)
    let value = 0
    if (action?.type === 'pass' || action?.type === 'loosePass') {
      const pickup = byId.get(action.originPickupActionId ?? '')
      value = action.originReception ? rank(action.originReception.sourceActionId) + 2
        : pickup && (pickup.type === 'move' || pickup.type === 'qMove') && pickup.ballTarget
          ? rank(pickup.ballTarget.sourceActionId) + 2 : 1
    } else if (action?.type === 'receive') {
      value = action.pickupActionId ? rank(action.ballSourceActionId) + 1
        : action.sourceActionId ? rank(action.sourceActionId) + 1 : 0
    } else if (action?.type === 'possession') value = 1
    // A completed shot ends the old episode before an independently authored
    // same-time fresh catch. Its timestamp is the end in both event consumers.
    else if (action?.type === 'shoot') value = -1
    visiting.delete(id)
    ranks.set(id, value)
    return value
  }
  for (const action of actions) rank(action.id)
  return ranks
}
