import { useStore } from '../../core/observable';
import { Menu } from '../../design/components/Menu';
import {
  BellIcon,
  CursorIcon,
  HLineToolIcon,
  RayToolIcon,
  RectToolIcon,
  TrashIcon,
  TrendToolIcon,
} from '../../design/icons';
import type { DrawingTool, DrawingsStore } from './drawings';

const TOOLS: { tool: DrawingTool; label: string; shortcut: string; Icon: typeof CursorIcon }[] = [
  { tool: 'cursor', label: 'Select / pan', shortcut: 'V', Icon: CursorIcon },
  { tool: 'trend', label: 'Trend line', shortcut: 'T', Icon: TrendToolIcon },
  { tool: 'ray', label: 'Ray', shortcut: 'R', Icon: RayToolIcon },
  { tool: 'hline', label: 'Horizontal line', shortcut: 'H', Icon: HLineToolIcon },
  { tool: 'rect', label: 'Box', shortcut: 'B', Icon: RectToolIcon },
  { tool: 'alert', label: 'Price alert', shortcut: 'A', Icon: BellIcon },
];

/** Drawing-tool dropdown for the chart header (TradingView-style tools). */
export function DrawToolsMenu({ store }: { store: DrawingsStore }) {
  const { tool, selectedId, drawings, alerts } = useStore(store);
  const hasAnnotations = drawings.length > 0 || alerts.length > 0;
  const ActiveIcon = TOOLS.find((t) => t.tool === tool)?.Icon ?? CursorIcon;

  return (
    <Menu
      trigger={
        <button
          className={`chart-icon-button${tool !== 'cursor' ? ' active' : ''}`}
          aria-label="Drawing tools"
          title="Drawing tools"
        >
          <ActiveIcon size={16} />
        </button>
      }
      items={[
        ...TOOLS.map(({ tool: t, label, shortcut, Icon }) => ({
          key: t,
          label: (
            <>
              <Icon size={14} />
              {label}
              <span
                style={{
                  marginLeft: 12,
                  fontSize: 'var(--fs-caption)',
                  color: 'var(--label-secondary)',
                }}
              >
                {shortcut}
              </span>
            </>
          ),
          checked: tool === t,
          onSelect: () => store.setTool(t),
        })),
        ...(hasAnnotations
          ? [
              {
                key: 'clear',
                label: (
                  <span
                    style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--pnl-negative)' }}
                  >
                    <TrashIcon size={14} />
                    {selectedId ? 'Delete selection' : 'Clear all drawings'}
                  </span>
                ),
                checked: false,
                onSelect: () => {
                  if (selectedId) {
                    store.removeSelectedOrClear();
                  } else if (
                    window.confirm('Clear all drawings and alerts for this symbol? (Cmd+Z to undo)')
                  ) {
                    store.removeSelectedOrClear();
                  }
                },
              },
            ]
          : []),
      ]}
    />
  );
}
