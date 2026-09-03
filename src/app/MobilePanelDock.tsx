export type MobilePanel = 'roster' | 'inspector' | 'timeline'

interface MobilePanelDockProps {
  activePanel: MobilePanel | null
  onToggle: (panel: MobilePanel) => void
}

const panels: Array<{ id: MobilePanel; label: string; symbol: string; controls: string }> = [
  { id: 'roster', label: '阵容', symbol: '队', controls: 'roster-panel' },
  { id: 'inspector', label: '属性', symbol: '检', controls: 'inspector-panel' },
  { id: 'timeline', label: '时间轴', symbol: '时', controls: 'timeline-panel' },
]

export function MobilePanelDock({ activePanel, onToggle }: MobilePanelDockProps) {
  return (
    <nav className="mobile-panel-dock" aria-label="手机面板">
      {panels.map((panel) => (
        <button
          key={panel.id}
          type="button"
          className={activePanel === panel.id ? 'active' : ''}
          aria-pressed={activePanel === panel.id}
          aria-expanded={activePanel === panel.id}
          aria-controls={panel.controls}
          onClick={() => onToggle(panel.id)}
        >
          <span aria-hidden="true">{panel.symbol}</span>
          <small>{panel.label}</small>
        </button>
      ))}
    </nav>
  )
}
