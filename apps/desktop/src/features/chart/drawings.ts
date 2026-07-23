import { Store } from '../../core/observable';

export type DrawingTool = 'cursor' | 'trend' | 'ray' | 'hline' | 'rect' | 'alert';
export type DrawingKind = 'trend' | 'ray' | 'hline' | 'rect';

export interface DrawingPoint {
  /** Bucket time in epoch seconds; may fall between/beyond bars. */
  time: number;
  price: number;
}

export interface Drawing {
  id: string;
  kind: DrawingKind;
  p1: DrawingPoint;
  /** Absent for hline (price level only) and while a draft is being placed. */
  p2: DrawingPoint | null;
}

export interface PriceAlert {
  id: string;
  price: number;
}

interface DrawingsState {
  symbol: string;
  tool: DrawingTool;
  drawings: Drawing[];
  alerts: PriceAlert[];
  selectedId: string | null;
  draft: Drawing | null;
}

const STORAGE_PREFIX = 'chart.drawings.';
const MAX_HISTORY = 50;

/**
 * TradingView-style chart annotations: trend lines, rays, horizontal lines,
 * boxes, and price alerts. Persisted per symbol in localStorage. Tools stay
 * armed after a placement (Escape/cursor disarms); destructive removes are
 * undoable via `undo` (Cmd/Ctrl+Z).
 */
export class DrawingsStore extends Store<DrawingsState> {
  private history: { drawings: Drawing[]; alerts: PriceAlert[] }[] = [];

  constructor() {
    super({
      symbol: '',
      tool: 'cursor',
      drawings: [],
      alerts: [],
      selectedId: null,
      draft: null,
    });
  }

  setSymbol(symbol: string): void {
    if (symbol === this.getState().symbol) return;
    let drawings: Drawing[] = [];
    let alerts: PriceAlert[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + symbol);
      if (raw) {
        const parsed = JSON.parse(raw) as { drawings?: Drawing[]; alerts?: PriceAlert[] };
        drawings = parsed.drawings ?? [];
        alerts = parsed.alerts ?? [];
      }
    } catch {
      // Corrupt entry: start clean.
    }
    this.history = [];
    this.set({ symbol, drawings, alerts, selectedId: null, draft: null, tool: 'cursor' });
  }

  setTool(tool: DrawingTool): void {
    this.set({ tool, selectedId: null, draft: null });
  }

  select(id: string | null): void {
    this.set({ selectedId: id });
  }

  // MARK: - Draft lifecycle (trend / ray / rect are drag-placed)

  beginDraft(kind: DrawingKind, point: DrawingPoint): void {
    this.set({
      draft: { id: crypto.randomUUID(), kind, p1: point, p2: point },
      selectedId: null,
    });
  }

  updateDraft(point: DrawingPoint): void {
    const { draft } = this.getState();
    if (!draft) return;
    this.set({ draft: { ...draft, p2: point } });
  }

  commitDraft(): void {
    const { draft, drawings } = this.getState();
    if (!draft) return;
    // The tool stays armed so repeated placements don't reopen the menu;
    // Escape / cursor disarm it.
    this.set({
      drawings: [...drawings, draft],
      draft: null,
      selectedId: draft.id,
    });
    this.persist();
  }

  cancelDraft(): void {
    this.set({ draft: null, tool: 'cursor' });
  }

  /** One-click shapes: horizontal line and price alert. */
  addHLine(price: number, time: number): void {
    const drawing: Drawing = {
      id: crypto.randomUUID(),
      kind: 'hline',
      p1: { time, price },
      p2: null,
    };
    this.set({
      drawings: [...this.getState().drawings, drawing],
      selectedId: drawing.id,
    });
    this.persist();
  }

  addAlert(price: number): void {
    this.set({
      alerts: [...this.getState().alerts, { id: crypto.randomUUID(), price }],
      tool: 'cursor',
    });
    this.persist();
  }

  // MARK: - Editing

  /** Drag-move edits: in-memory only; the pointer-up path calls persistNow. */
  updateDrawing(id: string, p1: DrawingPoint, p2: DrawingPoint | null): void {
    this.set({
      drawings: this.getState().drawings.map((d) => (d.id === id ? { ...d, p1, p2 } : d)),
    });
  }

  updateAlertPrice(id: string, price: number): void {
    this.set({
      alerts: this.getState().alerts.map((a) => (a.id === id ? { ...a, price } : a)),
    });
  }

  /** Arrow-key nudge of the selection (1 or 10 ticks / buckets per press). */
  nudgeSelected(key: string, steps: number): void {
    const { selectedId, drawings, alerts } = this.getState();
    if (!selectedId) return;
    let priceDir = 0;
    if (key === 'ArrowUp') priceDir = 1;
    else if (key === 'ArrowDown') priceDir = -1;
    const dPrice = priceDir * steps * 0.25; // tick
    let timeDir = 0;
    if (key === 'ArrowRight') timeDir = 1;
    else if (key === 'ArrowLeft') timeDir = -1;
    const dTime = timeDir * steps * 60; // 1m bucket
    this.set({
      drawings: drawings.map((d) =>
        d.id === selectedId
          ? {
              ...d,
              p1: { time: d.p1.time + dTime, price: d.p1.price + dPrice },
              p2: d.p2 ? { time: d.p2.time + dTime, price: d.p2.price + dPrice } : null,
            }
          : d,
      ),
      alerts: alerts.map((a) => (a.id === selectedId ? { ...a, price: a.price + dPrice } : a)),
    });
    this.persist();
  }

  // MARK: - Undo

  private snapshot(): void {
    const { drawings, alerts } = this.getState();
    this.history.push({ drawings, alerts });
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  /** Restores the state before the last destructive remove (Cmd/Ctrl+Z). */
  undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.set({ drawings: prev.drawings, alerts: prev.alerts, selectedId: null });
    this.persist();
  }

  /** Removes the selection if any, else clears every annotation for the symbol. */
  removeSelectedOrClear(): void {
    const { selectedId, drawings, alerts } = this.getState();
    if (drawings.length > 0 || alerts.length > 0) this.snapshot();
    if (selectedId) {
      this.set({
        drawings: drawings.filter((d) => d.id !== selectedId),
        alerts: alerts.filter((a) => a.id !== selectedId),
        selectedId: null,
      });
    } else {
      this.set({ drawings: [], alerts: [] });
    }
    this.persist();
  }

  removeSelected(): void {
    const { selectedId } = this.getState();
    if (selectedId) this.removeSelectedOrClear();
  }

  // MARK: - Alert crossing

  /** Returns alerts crossed between two consecutive last prices; removes them. */
  checkAlerts(previousLast: number, last: number): PriceAlert[] {
    if (previousLast === last) return [];
    const crossed = this.getState().alerts.filter(
      (alert) => (previousLast - alert.price) * (last - alert.price) <= 0,
    );
    if (crossed.length > 0) {
      const crossedIds = new Set(crossed.map((a) => a.id));
      this.set({ alerts: this.getState().alerts.filter((a) => !crossedIds.has(a.id)) });
      this.persist();
    }
    return crossed;
  }

  /** Public persist wrapper for the pointer-up path after a drag edit. */
  persistNow(): void {
    this.persist();
  }

  private persist(): void {
    const { symbol, drawings, alerts } = this.getState();
    if (!symbol) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + symbol, JSON.stringify({ drawings, alerts }));
    } catch {
      // Quota full or storage denied: keep in-memory state for the session.
    }
  }
}
