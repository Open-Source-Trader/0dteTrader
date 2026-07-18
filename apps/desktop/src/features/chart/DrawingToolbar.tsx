import { useStore } from '../../core/observable';
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

/** TradingView-style vertical drawing toolbar overlaying the chart. */
export function DrawingToolbar({ store }: { store: DrawingsStore }) {
  const { tool, selectedId, drawings, alerts } = useStore(store);
  const hasAnnotations = drawings.length > 0 || alerts.length > 0;

  return (
    <div className="draw-toolbar">
      {TOOLS.map(({ tool: t, label, Icon }) => (
        <button
          key={t}
          className={`draw-tool${tool === t ? ' active' : ''}`}
          title={label}
          aria-label={label}
          onClick={() => store.setTool(tool === t ? 'cursor' : t)}
        >
          <Icon size={15} />
        </button>
      ))}
      {hasAnnotations ? (
        <button
          className="draw-tool"
          title={selectedId ? 'Delete selection' : 'Clear all drawings'}
          aria-label={selectedId ? 'Delete selection' : 'Clear all drawings'}
          onClick={() => store.removeSelectedOrClear()}
        >
          <TrashIcon size={15} />
        </button>
      ) : null}
    </div>
  );
}
