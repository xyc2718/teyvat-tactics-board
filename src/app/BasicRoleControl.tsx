import { BASIC_ROLE_IDS, basicRoleDisplay, basicRoleRule, effectiveBasicRole } from '../domain/model/basicRoles'
import { isRangeInspectionTool } from '../editor/toolWorkflow'
import { useTacticStore } from '../editor/useTacticStore'

export function BasicRoleControl() {
  const document = useTacticStore((state) => state.document)
  const selection = useTacticStore((state) => state.selection)
  const tool = useTacticStore((state) => state.tool)
  const setBasicPlayerRole = useTacticStore((state) => state.setBasicPlayerRole)
  const player = selection?.kind === 'player'
    ? document.initialScene.players.find((candidate) => candidate.id === selection.id)
    : undefined
  const role = player ? effectiveBasicRole(document, player) : undefined
  const unavailableRange = role && isRangeInspectionTool(tool) && !basicRoleRule(role, document.rulesSnapshot)

  return <div className="basic-role-control" role="group" aria-label="基础模式球员角色">
    <span className="basic-role-player" title={player?.name}>{player ? player.name : '选择球员设置角色'}</span>
    <div className="basic-role-choices">
      {BASIC_ROLE_IDS.map((choice) => {
        const display = basicRoleDisplay(choice, document.rulesSnapshot)
        return <button
          key={choice}
          type="button"
          aria-label={`基础角色：${display.shortLabel}`}
          title={display.label}
          aria-pressed={role === choice}
          disabled={!player}
          onClick={() => { if (player) setBasicPlayerRole(player.id, choice) }}
        >{display.shortLabel}</button>
      })}
    </div>
    <p className="basic-role-note" aria-live="polite">{unavailableRange
      ? `${basicRoleDisplay(role, document.rulesSnapshot).label}的范围参数暂未提供`
      : ''}</p>
  </div>
}
