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

/**
 * TradingView-style chart annotations: trend lines, rays, horizontal lines,
 * boxes, and price alerts. Persisted per symbol in localStorage.
 */
export class DrawingsStore extends Store<DrawingsState> {
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
    this.set({
      drawings: [...drawings, draft],
      draft: null,
      tool: 'cursor',
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
      tool: 'cursor',
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

  updateDrawing(id: string, p1: DrawingPoint, p2: DrawingPoint | null): void {
    this.set({
      drawings: this.getState().drawings.map((d) => (d.id === id ? { ...d, p1, p2 } : d)),
    });
    this.persist();
  }

  updateAlertPrice(id: string, price: number): void {
    this.set({
      alerts: this.getState().alerts.map((a) => (a.id === id ? { ...a, price } : a)),
    });
    this.persist();
  }

  /** Removes the selection if any, else clears every annotation for the symbol. */
  removeSelectedOrClear(): void {
    const { selectedId, drawings, alerts } = this.getState();
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

  private persist(): void {
    const { symbol, drawings, alerts } = this.getState();
    if (!symbol) return;
    localStorage.setItem(STORAGE_PREFIX + symbol, JSON.stringify({ drawings, alerts }));
  }
}
