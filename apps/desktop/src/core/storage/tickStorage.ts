import type { TickInterval } from '@0dtetrader/shared-types';

const DB_NAME = '0dtetrader-ticks';
const STORE_NAME = 'candles';
// v2: state records ({candles, accumulator}) replace bare candle arrays and
// tick sizes changed (500t… → 10t…); the upgrade clears the stale v1 store.
const DB_VERSION = 2;
const MAX_CANDLES = 600;

interface TickCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickAccumulatorState {
  count: number;
  open: number;
  high: number;
  low: number;
  close: number;
  firstTimestamp: number;
}

/** Completed tick candles plus the in-progress accumulator, persisted per
 *  quote so an app restart resumes the partial candle. */
export interface StoredTickState {
  candles: TickCandle[];
  accumulator: TickAccumulatorState | null;
}

function storageKey(symbol: string, interval: TickInterval): string {
  return `${symbol}-${interval}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadTickState(
  symbol: string,
  interval: TickInterval,
): Promise<StoredTickState> {
  const empty: StoredTickState = { candles: [], accumulator: null };
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(storageKey(symbol, interval));
      req.onsuccess = () => {
        const value = req.result as StoredTickState | undefined;
        resolve(
          value && Array.isArray(value.candles)
            ? { candles: value.candles, accumulator: value.accumulator ?? null }
            : empty,
        );
      };
      req.onerror = () => resolve(empty);
    });
  } catch {
    return empty;
  }
}

export async function saveTickState(
  symbol: string,
  interval: TickInterval,
  state: StoredTickState,
): Promise<void> {
  try {
    const candles =
      state.candles.length > MAX_CANDLES ? state.candles.slice(-MAX_CANDLES) : state.candles;
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(
      { candles, accumulator: state.accumulator },
      storageKey(symbol, interval),
    );
  } catch {
    // IndexedDB unavailable — tick data is ephemeral.
  }
}
