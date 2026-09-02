import { useState } from 'react'
import type { MatchupRating, RoleId } from '../domain/model/types'
import { ROLE_IDS } from '../domain/rules/defaultRules'
import { useTacticStore } from '../editor/useTacticStore'
import { matchupLabel } from '../ui/labels'

type Tab = 'parameters' | 'matchups'

export function RulesDrawer() {
  const [tab, setTab] = useState<Tab>('parameters')
  const open = useTacticStore((state) => state.showRules)
  const close = useTacticStore((state) => state.setRulesOpen)
  const rules = useTacticStore((state) => state.document.rulesSnapshot)
  const updateField = useTacticStore((state) => state.updateFieldRule)
  const updatePassing = useTacticStore((state) => state.updatePassingRule)
  const updateShooting = useTacticStore((state) => state.updateShootingRule)
  const updateRole = useTacticStore((state) => state.updateRoleRule)
  const updateRoleExtra = useTacticStore((state) => state.updateRoleExtra)
  const setModifier = useTacticStore((state) => state.setModifier)
  const resetRules = useTacticStore((state) => state.resetRules)

  if (!open) return null

  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(false) }}>
      <aside className="rules-drawer" role="dialog" aria-modal="true" aria-label="规则设置">
        <div className="drawer-head">
          <div><span className="eyebrow">规则快照 · {rules.version}</span><h2>推演规则设置</h2><p>修改会立即同步到覆盖层、播放和规则提示，并随战术文件一起保存。</p></div>
          <button className="drawer-close" onClick={() => close(false)} aria-label="关闭规则设置">×</button>
        </div>
        <div className="drawer-tabs">
          <button className={tab === 'parameters' ? 'active' : ''} onClick={() => setTab('parameters')}>数值参数</button>
          <button className={tab === 'matchups' ? 'active' : ''} onClick={() => setTab('matchups')}>职业对位</button>
        </div>

        <div className="drawer-body">
          {tab === 'parameters' ? <>
            <RuleSection title="球场与基础移动" description="球场固定为 20 × 14 逻辑格。">
              <RuleInput label="基础移速" value={rules.field.baseMoveSpeed} suffix="格/s" onChange={(value) => updateField('baseMoveSpeed', value)} />
              <RuleInput label="小禁区半径" value={rules.field.smallPenaltyRadius} suffix="格" onChange={(value) => updateField('smallPenaltyRadius', value)} />
              <RuleInput label="大禁区半径" value={rules.field.largePenaltyRadius} suffix="格" onChange={(value) => updateField('largePenaltyRadius', value)} />
            </RuleSection>
            <RuleSection title="传球" description="按最远传球标定：球从 2 倍标定速度线性减速至 0；默认 8 格耗时 1 秒。">
              <RuleInput label="安全距离" value={rules.passing.safeDistance} suffix="格" onChange={(value) => updatePassing('safeDistance', value)} />
              <RuleInput label="最大有效距离" value={rules.passing.maxDistance} suffix="格" onChange={(value) => updatePassing('maxDistance', value)} />
              <RuleInput label="标定球速" value={rules.passing.ballSpeed} suffix="格/s" onChange={(value) => updatePassing('ballSpeed', value)} />
              <RuleInput label="截断锥起点宽" value={rules.passing.interceptStartWidth} suffix="格" onChange={(value) => updatePassing('interceptStartWidth', value)} />
              <RuleInput label="截断锥终点宽" value={rules.passing.interceptEndWidth} suffix="格" onChange={(value) => updatePassing('interceptEndWidth', value)} />
            </RuleSection>
            <RuleSection title="射门蓄力" description="有效攻击在蓄力完成前命中会中断射门。">
              <RuleInput label="大禁区黄蓄" value={rules.shooting.outerYellow} suffix="s" onChange={(value) => updateShooting('outerYellow', value)} />
              <RuleInput label="大禁区红蓄" value={rules.shooting.outerRed} suffix="s" onChange={(value) => updateShooting('outerRed', value)} />
              <RuleInput label="小禁区黄蓄" value={rules.shooting.innerYellow} suffix="s" onChange={(value) => updateShooting('innerYellow', value)} />
              <RuleInput label="小禁区红蓄" value={rules.shooting.innerRed} suffix="s" onChange={(value) => updateShooting('innerRed', value)} />
            </RuleSection>
            {ROLE_IDS.map((role) => {
              const rule = rules.roles[role]
              const boost = rule.afterQBoost ?? rule.receiveBoost
              return <RuleSection key={role} title={`${rule.label}（${rule.shortLabel}）`} description={rule.q.kind === 'blink' ? 'Q 规则时间按瞬时位移处理。' : 'Q 按加速冲刺播放。'}>
                <RuleInput label="攻击半径" value={rule.attackRadius} suffix="格" onChange={(value) => updateRole(role, 'attackRadius', value)} />
                {rule.attackInnerRadius !== undefined && <RuleInput label="攻击内半径" value={rule.attackInnerRadius} suffix="格" onChange={(value) => updateRole(role, 'attackInnerRadius', value)} />}
                <RuleInput label="Q 最大距离" value={rule.q.maxDistance} suffix="格" onChange={(value) => updateRole(role, 'qDistance', value)} />
                <RuleInput label="Q 冷却" value={rule.q.cooldown} suffix="s" onChange={(value) => updateRole(role, 'qCooldown', value)} />
                <RuleInput label="Q 位移时间" value={rule.q.duration} suffix="s" onChange={(value) => updateRole(role, 'qDuration', value)} />
                {boost && <>
                  <RuleInput label="加速有效时间" value={boost.duration} suffix="s" onChange={(value) => updateRoleExtra(role, 'boostDuration', value)} />
                  <RuleInput label="累计身位收益" value={boost.netSeparationGain} suffix="格" onChange={(value) => updateRoleExtra(role, 'boostGain', value)} />
                </>}
                {rule.q.freezeDuration !== undefined && <RuleInput label="冻结时间" value={rule.q.freezeDuration} suffix="s" onChange={(value) => updateRoleExtra(role, 'freezeDuration', value)} />}
                {rule.q.facingKnockback !== undefined && <RuleInput label="面向后退" value={rule.q.facingKnockback} suffix="格" onChange={(value) => updateRoleExtra(role, 'knockback', value)} />}
                {rule.slow && <>
                  <RuleInput label="完整减速时间" value={rule.slow.duration} suffix="s" onChange={(value) => updateRoleExtra(role, 'slowFullDuration', value)} />
                  <RuleInput label="完整身位损失" value={rule.slow.fullSeparationLoss} suffix="格" onChange={(value) => updateRoleExtra(role, 'slowFullLoss', value)} />
                  <RuleInput label="有效减速时间" value={rule.slow.effectiveDuration} suffix="s" onChange={(value) => updateRoleExtra(role, 'slowDuration', value)} />
                  <RuleInput label="有效身位损失" value={rule.slow.effectiveSeparationLoss} suffix="格" onChange={(value) => updateRoleExtra(role, 'slowLoss', value)} />
                </>}
                {rule.e && <>
                  <RuleInput label="E 冰圈半径" value={rule.e.radius} suffix="格" onChange={(value) => updateRoleExtra(role, 'eRadius', value)} />
                  <RuleInput label="E 持续" value={rule.e.duration} suffix="s" onChange={(value) => updateRoleExtra(role, 'eDuration', value)} />
                  <RuleInput label="E 冷却" value={rule.e.cooldown} suffix="s" onChange={(value) => updateRoleExtra(role, 'eCooldown', value)} />
                  <RuleInput label="E 圈内移速" value={rule.e.slowMultiplier} suffix="×" onChange={(value) => updateRoleExtra(role, 'eSlowMultiplier', value)} />
                  <RuleInput label="E 圈内敌方 Q 距离" value={rule.e.qDistanceMultiplier} suffix="×" onChange={(value) => updateRoleExtra(role, 'eQDistanceMultiplier', value)} />
                </>}
              </RuleSection>
            })}
          </> : <>
            <section className="matchup-editor">
              <div className="rule-section-head"><h3>有方向的基础对位</h3><p>统一从进攻方视角评价；默认参照双方水平相当。未确认的组合可保留“未评估”。</p></div>
              <div className="matchup-grid" style={{ gridTemplateColumns: `120px repeat(${ROLE_IDS.length}, 1fr)` }}>
                <span className="matrix-corner">进攻 ↓ / 防守 →</span>
                {ROLE_IDS.map((role) => <strong key={`head-${role}`}>{rules.roles[role].shortLabel} · {rules.roles[role].label}</strong>)}
                {ROLE_IDS.map((attacker) => <MatchupRow key={attacker} attacker={attacker} />)}
              </div>
            </section>
            <details className="advanced-modifiers">
              <summary><span>高级场景修正</span><small>按条件升降 1–2 档</small></summary>
              <div className="modifier-editor-list">
                {rules.modifiers.map((modifier) => <div key={modifier.id} className="modifier-editor-row">
                  <label className="switch-label"><input type="checkbox" checked={modifier.enabled} onChange={(event) => setModifier(modifier.id, 'enabled', event.target.checked)} /><span />{modifier.label}</label>
                  <select value={modifier.delta} onChange={(event) => setModifier(modifier.id, 'delta', Number(event.target.value))}>
                    <option value="-2">下降 2 档</option><option value="-1">下降 1 档</option><option value="1">上升 1 档</option><option value="2">上升 2 档</option>
                  </select>
                </div>)}
              </div>
            </details>
          </>}
        </div>
        <div className="drawer-footer">
          <button className="quiet-button" onClick={resetRules}>恢复 MVP 默认值</button>
          <p>这些数值是可校准的近似值，不代表自动胜负结论。</p>
          <button className="accent-button" onClick={() => close(false)}>完成</button>
        </div>
      </aside>
    </div>
  )
}

function RuleSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="rule-section"><div className="rule-section-head"><h3>{title}</h3><p>{description}</p></div><div className="rule-input-grid">{children}</div></section>
}

function RuleInput({ label, value, suffix, onChange }: { label: string; value: number; suffix: string; onChange: (value: number) => void }) {
  return <label className="rule-input"><span>{label}</span><div><input type="number" min="0" step="0.01" value={Number(value.toFixed(3))} onChange={(event) => onChange(Number(event.target.value))} /><em>{suffix}</em></div></label>
}

function MatchupRow({ attacker }: { attacker: RoleId }) {
  const rules = useTacticStore((state) => state.document.rulesSnapshot)
  const setMatchup = useTacticStore((state) => state.setMatchup)
  const values: MatchupRating[] = [null, -2, -1, 0, 1, 2]
  return <>
    <strong className="matrix-row-head">{rules.roles[attacker].shortLabel} · {rules.roles[attacker].label}</strong>
    {ROLE_IDS.map((defender) => <select key={`${attacker}-${defender}`} value={rules.matchups[attacker][defender] ?? 'none'} onChange={(event) => setMatchup(attacker, defender, event.target.value === 'none' ? null : Number(event.target.value) as MatchupRating)}>
      {values.map((value) => <option key={value ?? 'none'} value={value ?? 'none'}>{matchupLabel(value)}</option>)}
    </select>)}
  </>
}
