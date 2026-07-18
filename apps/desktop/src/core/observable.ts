import { useSyncExternalStore } from 'react';

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

export function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
