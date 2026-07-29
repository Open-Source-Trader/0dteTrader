import { useCallback, useRef, useSyncExternalStore } from 'react';

/**
 * Minimal observable-state base, the web analog of the iOS ObservableObject
 * view models. State is an immutable snapshot; `set` patches and notifies.
 */
export class Store<S> {
  private listeners = new Set<() => void>();

  constructor(protected state: S) {}

  getState = (): S => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  protected set(patch: Partial<S>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

/** Full-state subscription: re-renders on every `set()`, whatever changed. */
export function useStore<S>(store: Store<S>): S;
/**
 * Selector subscription: re-renders only when `selector(state)` actually
 * changes (by `isEqual`, default `Object.is`) — a store's `set()` still
 * notifies every subscriber, but a component reading only a slice of a
 * store shared with others no longer re-renders for changes outside that
 * slice. Same shape as `use-sync-external-store/with-selector`, inlined
 * since React 19's built-in `useSyncExternalStore` has no selector param.
 */
export function useStore<S, T>(
  store: Store<S>,
  selector: (state: S) => T,
  isEqual?: (a: T, b: T) => boolean,
): T;
export function useStore<S, T>(
  store: Store<S>,
  selector?: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): S | T {
  const cache = useRef<{ state: S; selected: T } | null>(null);

  const getSnapshot = useCallback((): S | T => {
    if (!selector) return store.getState();
    const state = store.getState();
    if (cache.current && cache.current.state === state) {
      return cache.current.selected;
    }
    const selected = selector(state);
    if (cache.current && isEqual(cache.current.selected, selected)) {
      cache.current = { state, selected: cache.current.selected };
      return cache.current.selected;
    }
    cache.current = { state, selected };
    return selected;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, selector]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** One-level `Object.is` comparison of own enumerable keys — the usual
 *  `isEqual` for a selector that returns a fresh `{ ...slice }` object each
 *  call. */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  const aKeys = Object.keys(a) as (keyof T)[];
  const bKeys = Object.keys(b) as (keyof T)[];
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.is(a[key], b[key]));
}
