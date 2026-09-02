import { projectFrame } from '../domain/timeline/projectFrame'
import { useTacticStore } from '../editor/useTacticStore'
import { isRangeInspectionTool, isToolActorEligible, isToolTargetPlayerEligible, resolveToolActor, toolNeedsActor } from '../editor/toolWorkflow'

export function RosterPanel() {
  const document = useTacticStore((state) => state.document)
  const currentTime = useTacticStore((state) => state.currentTime)
  const selection = useTacticStore((state) => state.selection)
  const tool = useTacticStore((state) => state.tool)
  const select = useTacticStore((state) => state.select)
  const chooseActor = useTacticStore((state) => state.chooseActorForTool)
  const createAction = useTacticStore((state) => state.createAction)
  const frame = projectFrame(document, currentTime)
  const selectedPlayer = selection?.kind === 'player'
    ? frame.players.find((player) => player.id === selection.id)
    : undefined
  const actor = toolNeedsActor(tool)
    ? resolveToolActor(tool, selectedPlayer, frame, document.rulesSnapshot)
    : selectedPlayer

  function handlePlayerClick(playerId: string) {
    const player = frame.players.find((candidate) => candidate.id === playerId)
    if (!player) return
    if (tool === 'select') {
      select({ kind: 'player', id: player.id })
      return
    }
    if (isRangeInspectionTool(tool)) {
      chooseActor(player.id)
      return
    }
    if (tool === 'shoot') {
      chooseActor(player.id)
      return
    }
    if (tool === 'move' || tool === 'qMove') {
      chooseActor(player.id)
      return
    }
    if (toolNeedsActor(tool) && !actor) {
      chooseActor(player.id)
      return
    }
    createAction(actor?.id ?? null, player.position, player.id)
  }

  return (
    <aside className="roster-panel panel-surface">
      <div className="panel-heading">
        <div><span className="eyebrow">阵容</span><h2>场上角色</h2></div>
        <span className="tiny-pill">3 v 3</span>
      </div>
      {(['blue', 'red'] as const).map((team) => (
        <section key={team} className="team-roster">
          <div className={`team-title team-${team}-text`}><span className="team-dot" />{team === 'blue' ? '蓝方 · 向右进攻' : '红方 · 向左进攻'}</div>
          {frame.players.filter((player) => player.team === team).map((player) => {
            const role = document.rulesSnapshot.roles[player.role]
            const selected = selection?.kind === 'player' && selection.id === player.id
            const statuses = frame.statuses.filter((status) => status.playerId === player.id)
            const actorCandidate = isRangeInspectionTool(tool)
              || (tool !== 'select'
                && (!actor || tool === 'move' || tool === 'qMove')
                && isToolActorEligible(tool, player, frame, document.rulesSnapshot))
            const targetCandidate = tool !== 'select' && !isRangeInspectionTool(tool) && tool !== 'move' && tool !== 'qMove' && actor
              ? isToolTargetPlayerEligible(tool, actor, player)
              : false
            const workflowDimmed = tool !== 'select' && !isRangeInspectionTool(tool) && toolNeedsActor(tool) && !selected && !actorCandidate && !targetCandidate && (!actor || tool === 'pass' || tool === 'qMove')
            return (
              <button
                key={player.id}
                className={`roster-item ${selected ? 'selected' : ''} ${actorCandidate || targetCandidate ? 'workflow-eligible' : ''} ${workflowDimmed ? 'workflow-dimmed' : ''}`}
                onClick={() => handlePlayerClick(player.id)}
              >
                <span className={`roster-avatar role-${player.role}`}>{role.shortLabel}</span>
                <span className="roster-copy"><strong>{player.name}</strong><small>{role.label} · ({player.position.x.toFixed(1)}, {player.position.y.toFixed(1)})</small></span>
                <span className="roster-state">{player.hasBall ? '持球' : statuses[0]?.kind === 'frozen' ? '冻结' : statuses[0]?.kind === 'slowed' ? '减速' : ''}</span>
              </button>
            )
          })}
        </section>
      ))}
      <div className="legend-block">
        <span><i className="legend-line move" />跑动</span>
        <span><i className="legend-line q" />Q 位移</span>
        <span><i className="legend-line pass" />传球</span>
        <span><i className="legend-line shoot" />射门</span>
      </div>
    </aside>
  )
}
