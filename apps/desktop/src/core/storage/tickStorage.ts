import type { TickInterval } from '@0dtetrader/shared-types';

const DB_NAME = '0dtetrader-ticks';
const STORE_NAME = 'candles';
const DB_VERSION = 1;
const MAX_CANDLES = 600;

interface TickCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function storageKey(symbol: string, interval: TickInterval): string {
  return `${symbol}-${interval}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadTickCandles(
  symbol: string,
  interval: TickInterval,
): Promise<TickCandle[]> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(storageKey(symbol, interval));
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function saveTickCandles(
  symbol: string,
  interval: TickInterval,
  candles: TickCandle[],
): Promise<void> {
  try {
    const trimmed = candles.length > MAX_CANDLES ? candles.slice(-MAX_CANDLES) : candles;
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(trimmed, storageKey(symbol, interval));
  } catch {
    // IndexedDB unavailable — tick data is ephemeral.
  }
}
