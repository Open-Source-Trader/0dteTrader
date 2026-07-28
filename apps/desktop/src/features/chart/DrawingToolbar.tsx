import { useStore } from '../../core/observable';
import { Menu } from '../../design/components/Menu';
import {
  BellIcon,
  ClockIcon,
  CursorIcon,
  HLineToolIcon,
  LockIcon,
  LockOpenIcon,
  PersonCircleIcon,
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

/** Drawing-tool dropdown on the chart's chip row (TradingView-style tools). */
export function DrawToolsMenu({ store }: { store: DrawingsStore }) {
  const { tool, selectedId, drawings, alerts } = useStore(store);
  const hasAnnotations = drawings.length > 0 || alerts.length > 0;
  const ActiveIcon = TOOLS.find((t) => t.tool === tool)?.Icon ?? CursorIcon;

  return (
    <Menu
      edge="trailing"
      trigger={
        <button
          className={`chart-chip${tool !== 'cursor' ? ' active' : ''}`}
          aria-label="Drawing tools"
          title="Drawing tools"
        >
          <ActiveIcon size={13} />
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
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: 'var(--pnl-negative)',
                    }}
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

interface DrawToolsRailProps {
  store: DrawingsStore;
  /** Global app actions (lock/history/profile), anchored to the rail's
   *  bottom — the left rail is the one element always visible in the
   *  desktop grid regardless of panel layout, so it's the natural home
   *  for chrome that must stay reachable no matter how chart/ticket are
   *  split. Omitted entirely when the caller doesn't wire them (e.g. if
   *  the rail is ever reused somewhere without app-level chrome). */
  locked?: boolean;
  onToggleLock?: () => void;
  onShowHistory?: () => void;
  onShowProfile?: () => void;
}

/** Persistent vertical drawing-tool rail (desktop grid only) — TradingView's
 *  left-edge toolbar convention: every tool is always one click away instead
 *  of two (open menu, then pick). The "clear" action stays a small trailing
 *  button rather than living inside a dropdown, so it's not one hover away
 *  from every other tool. */
export function DrawToolsRail({
  store,
  locked,
  onToggleLock,
  onShowHistory,
  onShowProfile,
}: DrawToolsRailProps) {
  const { tool, selectedId, drawings, alerts } = useStore(store);
  const hasAnnotations = drawings.length > 0 || alerts.length > 0;
  const hasAppActions = onToggleLock || onShowHistory || onShowProfile;

  return (
    <div className="draw-rail">
      {TOOLS.map(({ tool: t, label, shortcut, Icon }) => (
        <button
          key={t}
          className={`chart-icon-button draw-rail-button${tool === t ? ' active' : ''}`}
          onClick={() => store.setTool(t)}
          aria-label={label}
          aria-pressed={tool === t}
          title={`${label} (${shortcut})`}
        >
          <Icon size={19} />
        </button>
      ))}
      {hasAnnotations ? (
        <button
          className="chart-icon-button draw-rail-button draw-rail-clear"
          onClick={() => {
            if (selectedId) {
              store.removeSelectedOrClear();
            } else if (
              window.confirm('Clear all drawings and alerts for this symbol? (Cmd+Z to undo)')
            ) {
              store.removeSelectedOrClear();
            }
          }}
          aria-label={selectedId ? 'Delete selection' : 'Clear all drawings'}
          title={selectedId ? 'Delete selection' : 'Clear all drawings'}
        >
          <TrashIcon size={18} />
        </button>
      ) : null}
      {hasAppActions ? (
        <div className="draw-rail-app-actions">
          {onToggleLock ? (
            <button
              className="chart-icon-button draw-rail-button"
              onClick={onToggleLock}
              aria-pressed={locked}
              aria-label={locked ? 'Unlock trading' : 'Lock trading'}
              title={locked ? 'Unlock trading' : 'Lock trading'}
            >
              {locked ? <LockIcon size={19} /> : <LockOpenIcon size={19} />}
            </button>
          ) : null}
          {onShowHistory ? (
            <button
              className="chart-icon-button draw-rail-button"
              onClick={onShowHistory}
              aria-label="Trade history"
              title="Trade history"
            >
              <ClockIcon size={19} />
            </button>
          ) : null}
          {onShowProfile ? (
            <button
              className="chart-icon-button draw-rail-button"
              onClick={onShowProfile}
              aria-label="Profile"
              title="Profile"
            >
              <PersonCircleIcon size={19} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
