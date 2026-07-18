import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../core/api/ApiClient';
import { TradeStore } from './TradeStore';

function makeStore(): TradeStore {
  const apiClient = {
    previewOrder: async () => {
      throw new Error('preview unavailable in test');
    },
  } as unknown as ApiClient;
  return new TradeStore(apiClient);
}

describe('TradeStore.setQuantity', () => {
  it('clamps to the server-accepted range [1, 1000]', () => {
    const store = makeStore();
    store.setQuantity(0);
    expect(store.getState().quantity).toBe(1);
    store.setQuantity(5000);
    expect(store.getState().quantity).toBe(1000);
  });
});
