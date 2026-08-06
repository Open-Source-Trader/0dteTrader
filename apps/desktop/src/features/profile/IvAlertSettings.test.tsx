// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IVAlertConfigurationState } from '@0dtetrader/shared-types';
import { QuoteSocket } from '../../core/api/QuoteSocket';
import { IvAlertSettings } from './IvAlertSettings';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MockWebSocket {
  static readonly OPEN = 1;
  readonly readyState = MockWebSocket.OPEN;
  readonly send = vi.fn();
}

const configuration: IVAlertConfigurationState = {
  enabled: false,
  symbols: ['SPX', 'NDX', 'RUT'],
  lookbackMinutes: 30,
  thresholdK: 3,
  consecutiveBreaches: 2,
  warmupMinutes: 10,
  warmupSamples: 10,
  cooldownMinutes: 5,
  schemaVersion: 1,
  updatedAt: '2026-08-05T14:00:00.000Z',
};

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('IvAlertSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let socket: QuoteSocket;
  let webSocket: MockWebSocket;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('WebSocket', MockWebSocket);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    socket = new QuoteSocket('wss://example.test/v1/stream', async () => 'token');
    webSocket = new MockWebSocket();
    (socket as unknown as { ws: MockWebSocket }).ws = webSocket;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('consumes received configuration and exposes every bounded field with accessible names', () => {
    act(() => root.render(<IvAlertSettings socket={socket} />));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Waiting for alert settings',
    );

    act(() => {
      (socket as unknown as { processMessage(raw: string): void }).processMessage(
        JSON.stringify({ type: 'ivAlertConfiguration', data: configuration }),
      );
    });

    expect(
      container.querySelector('[role="switch"][aria-label="Enable ATM IV alerts"]'),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Lookback minutes"]')?.value,
    ).toBe('30');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Anomaly threshold"]')?.max,
    ).toBe('20');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Consecutive breaches"]')?.max,
    ).toBe('10');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Warmup minutes"]')?.min,
    ).toBe('0');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Warmup samples"]')?.max,
    ).toBe('240');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Cooldown minutes"]')?.max,
    ).toBe('1440');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="SPX alerts"]')?.checked,
    ).toBe(true);
  });

  it('sends the exact validated editable configuration and reports server confirmation', () => {
    act(() => root.render(<IvAlertSettings socket={socket} />));
    act(() => {
      (socket as unknown as { processMessage(raw: string): void }).processMessage(
        JSON.stringify({ type: 'ivAlertConfiguration', data: configuration }),
      );
    });

    const enabled = container.querySelector<HTMLButtonElement>('[role="switch"]');
    const ndx = container.querySelector<HTMLInputElement>('input[aria-label="NDX alerts"]');
    const threshold = container.querySelector<HTMLInputElement>(
      'input[aria-label="Anomaly threshold"]',
    );
    const save = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    act(() => {
      enabled?.click();
      ndx?.click();
      if (threshold) setInput(threshold, '4.5');
    });
    act(() => save?.click());

    expect(webSocket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'ivAlertConfigure',
        data: {
          enabled: true,
          symbols: ['SPX', 'RUT'],
          lookbackMinutes: 30,
          thresholdK: 4.5,
          consecutiveBreaches: 2,
          warmupMinutes: 10,
          warmupSamples: 10,
          cooldownMinutes: 5,
        },
      }),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Waiting for server confirmation',
    );
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="NDX alerts"]')?.checked,
    ).toBe(false);
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Anomaly threshold"]')?.value,
    ).toBe('4.5');

    const confirmed = {
      ...configuration,
      enabled: true,
      symbols: ['SPX', 'RUT'],
      thresholdK: 4.5,
    } satisfies IVAlertConfigurationState;
    act(() => {
      (socket as unknown as { processMessage(raw: string): void }).processMessage(
        JSON.stringify({ type: 'ivAlertConfiguration', data: confirmed }),
      );
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Alert settings saved',
    );
  });

  it('reports a socket write failure instead of waiting forever', () => {
    act(() => root.render(<IvAlertSettings socket={socket} />));
    act(() => {
      (socket as unknown as { processMessage(raw: string): void }).processMessage(
        JSON.stringify({ type: 'ivAlertConfiguration', data: configuration }),
      );
    });
    webSocket.send.mockImplementation(() => {
      throw new Error('socket write failed');
    });

    act(() => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());

    expect(container.querySelector('[role="alert"]')?.textContent ?? '').toContain(
      'Reconnect before saving',
    );
    expect(container.textContent).not.toContain('Waiting for server confirmation');
  });

  it('reports a server rejection instead of waiting forever', () => {
    act(() => root.render(<IvAlertSettings socket={socket} />));
    act(() => {
      (socket as unknown as { processMessage(raw: string): void }).processMessage(
        JSON.stringify({ type: 'ivAlertConfiguration', data: configuration }),
      );
    });
    act(() => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    expect(container.textContent).toContain('Waiting for server confirmation');

    act(() => {
      (socket as unknown as { processMessage(raw: string): void }).processMessage(
        JSON.stringify({
          type: 'error',
          error: { code: 'IV_ALERT_CONFIGURATION_INVALID', message: 'storage unavailable' },
        }),
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent ?? '').toContain(
      'storage unavailable',
    );
    expect(container.textContent).not.toContain('Waiting for server confirmation');
  });

  it('reports repeated identical server rejections on separate save attempts', () => {
    act(() => root.render(<IvAlertSettings socket={socket} />));
    const process = (message: unknown): void => {
      act(() => {
        (socket as unknown as { processMessage(raw: string): void }).processMessage(
          JSON.stringify(message),
        );
      });
    };
    process({ type: 'ivAlertConfiguration', data: configuration });
    const rejection = {
      type: 'error',
      error: { code: 'IV_ALERT_CONFIGURATION_INVALID', message: 'storage unavailable' },
    };

    act(() => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    process(rejection);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('storage unavailable');

    act(() => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    expect(container.textContent).toContain('Waiting for server confirmation');
    process(rejection);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('storage unavailable');
    expect(container.textContent).not.toContain('Waiting for server confirmation');
  });

  it('does not treat an unrelated websocket error as an IV settings rejection', () => {
    act(() => root.render(<IvAlertSettings socket={socket} />));
    act(() => {
      (socket as unknown as { processMessage(raw: string): void }).processMessage(
        JSON.stringify({ type: 'ivAlertConfiguration', data: configuration }),
      );
    });
    act(() => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());

    act(() => {
      (socket as unknown as { processMessage(raw: string): void }).processMessage(
        JSON.stringify({
          type: 'error',
          error: { code: 'SUBSCRIPTION_LIMIT', message: 'too many symbols' },
        }),
      );
    });

    expect(container.textContent).toContain('Waiting for server confirmation');
    expect(container.textContent).not.toContain('Server rejected these alert settings');
  });

  it('clears pending state on a mismatched server configuration and asks for retry', () => {
    act(() => root.render(<IvAlertSettings socket={socket} />));
    const processMessage = (data: IVAlertConfigurationState): void => {
      act(() => {
        (socket as unknown as { processMessage(raw: string): void }).processMessage(
          JSON.stringify({ type: 'ivAlertConfiguration', data }),
        );
      });
    };
    processMessage(configuration);

    const threshold = container.querySelector<HTMLInputElement>(
      'input[aria-label="Anomaly threshold"]',
    );
    act(() => {
      if (threshold) setInput(threshold, '4.5');
    });
    act(() => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    expect(container.textContent).toContain('Waiting for server confirmation');

    processMessage({ ...configuration });
    expect(container.querySelector('[role="alert"]')?.textContent ?? '').toContain('retry');
    expect(container.textContent).not.toContain('Waiting for server confirmation');

    processMessage({
      ...configuration,
      thresholdK: 4.5,
      updatedAt: '2026-08-05T14:01:00.000Z',
    });
    expect(container.querySelector('[role="alert"]')?.textContent ?? '').toContain('retry');
    expect(container.textContent).not.toContain('Alert settings saved');
  });

  it('blocks invalid bounds and an empty symbol selection before sending', () => {
    act(() => root.render(<IvAlertSettings socket={socket} />));
    act(() => {
      (socket as unknown as { processMessage(raw: string): void }).processMessage(
        JSON.stringify({ type: 'ivAlertConfiguration', data: configuration }),
      );
    });

    const threshold = container.querySelector<HTMLInputElement>(
      'input[aria-label="Anomaly threshold"]',
    );
    act(() => {
      if (threshold) setInput(threshold, '20.1');
    });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('valid values');

    act(() => {
      if (threshold) setInput(threshold, '3');
      for (const symbol of ['SPX', 'NDX', 'RUT']) {
        container.querySelector<HTMLInputElement>(`input[aria-label="${symbol} alerts"]`)?.click();
      }
    });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('at least one symbol');
    expect(webSocket.send).not.toHaveBeenCalled();
  });
});
