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

const TOOLS: { tool: DrawingTool; label: string; Icon: typeof CursorIcon }[] = [
  { tool: 'cursor', label: 'Select / pan', Icon: CursorIcon },
  { tool: 'trend', label: 'Trend line', Icon: TrendToolIcon },
  { tool: 'ray', label: 'Ray', Icon: RayToolIcon },
  { tool: 'hline', label: 'Horizontal line', Icon: HLineToolIcon },
  { tool: 'rect', label: 'Box', Icon: RectToolIcon },
  { tool: 'alert', label: 'Price alert', Icon: BellIcon },
];

/** Drawing-tool dropdown for the chart header (TradingView-style tools). */
export function DrawToolsMenu({ store }: { store: DrawingsStore }) {
  const { tool, selectedId, drawings, alerts } = useStore(store);
  const hasAnnotations = drawings.length > 0 || alerts.length > 0;
  const ActiveIcon = TOOLS.find((t) => t.tool === tool)?.Icon ?? CursorIcon;
  const toolActive = tool !== 'cursor';

  return (
    <Menu
      trigger={
        <button
          style={{
            padding: 8,
            background: toolActive ? 'var(--app-accent)' : 'var(--app-surface-elevated)',
            color: toolActive ? '#fff' : 'var(--label-primary)',
            borderRadius: '50%',
            display: 'flex',
          }}
          aria-label="Drawing tools"
          title="Drawing tools"
        >
          <ActiveIcon size={15} />
        </button>
      }
      items={[
        ...TOOLS.map(({ tool: t, label, Icon }) => ({
          key: t,
          label: (
            <>
              <Icon size={14} />
              {label}
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
                onSelect: () => store.removeSelectedOrClear(),
              },
            ]
          : []),
      ]}
    />
  );
}
