export interface ChartRepaintSignal {
  subscribe(listener: () => void): () => void;
  emit(): void;
}

/** Synchronous invalidation signal for chart transforms with no library event API. */
export function createChartRepaintSignal(): ChartRepaintSignal {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener();
    },
  };
}
