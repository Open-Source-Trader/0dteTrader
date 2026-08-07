// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GexHeatmapSnapshot, GexTermStructureSnapshot } from '@0dtetrader/shared-types';
import { ContainerProvider } from '../../app/container';
import { SettingsStore } from '../../core/storage/SettingsStore';
import { GexHeatmapModal } from './GexHeatmapModal';

const termStructureSnapshot: GexTermStructureSnapshot = {
  underlyingSymbol: 'SPY',
  expirations: ['2026-08-21'],
  strikes: [500],
  cells: [
    {
      timestamp: '2026-08-06T14:30:00.000Z',
      strike: 500,
      callGex: 1_000,
      putGex: -500,
      netGex: 500,
      dataQuality: 'complete',
      expiration: '2026-08-21',
    },
  ],
};

const timeSeriesSnapshot: GexHeatmapSnapshot = {
  underlyingSymbol: 'SPY',
  expiration: '2026-08-21',
  spotSeries: [500],
  timestamps: ['2026-08-06T14:30:00.000Z'],
  strikes: [500],
  cells: [
    {
      timestamp: '2026-08-06T14:30:00.000Z',
      strike: 500,
      callGex: 1_000,
      putGex: -500,
      netGex: 500,
      dataQuality: 'complete',
    },
  ],
};

function renderModal(
  apiClient: {
    gexTermStructure: ReturnType<typeof vi.fn>;
    gexHeatmap: ReturnType<typeof vi.fn>;
  },
  spotPrice = 500,
) {
  const settingsStore = new SettingsStore();
  const container = { apiClient, settingsStore } as never;
  return render(
    createElement(
      ContainerProvider,
      { value: container },
      createElement(GexHeatmapModal, {
        symbol: 'SPY',
        spotPrice,
        bid: 499.95,
        ask: 500.05,
        expirations: ['2026-08-21', '2026-08-22'],
        selectedExpiration: '2026-08-21',
        chartInterval: '5m',
        onDismiss: () => {},
      }),
    ),
  );
}

describe('GexHeatmapModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('requests an integer strike range even for a fractional spot price', async () => {
    // The API rejects non-integer strikeRangeAboveSpot/BelowSpot ("must be
    // an integer number") — a fractional spot price (e.g. 587.32) times the
    // 0.08 window fraction produces a fractional value unless it's rounded.
    const apiClient = {
      gexTermStructure: vi.fn().mockResolvedValue(termStructureSnapshot),
      gexHeatmap: vi.fn().mockResolvedValue(timeSeriesSnapshot),
    };
    renderModal(apiClient, 587.32);

    await waitFor(() => expect(apiClient.gexTermStructure).toHaveBeenCalled());
    const [, options] = apiClient.gexTermStructure.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(Number.isInteger(options.strikeRangeAboveSpot)).toBe(true);
    expect(Number.isInteger(options.strikeRangeBelowSpot)).toBe(true);
  });

  it('defaults to the term-structure view and renders its data', async () => {
    const apiClient = {
      gexTermStructure: vi.fn().mockResolvedValue(termStructureSnapshot),
      gexHeatmap: vi.fn().mockResolvedValue(timeSeriesSnapshot),
    };
    renderModal(apiClient);

    await waitFor(() => expect(apiClient.gexTermStructure).toHaveBeenCalled());
    expect(apiClient.gexHeatmap).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('2026-08-21')).toBeInTheDocument());
  });

  it('switches to the time-series view and fetches gexHeatmap instead', async () => {
    const apiClient = {
      gexTermStructure: vi.fn().mockResolvedValue(termStructureSnapshot),
      gexHeatmap: vi.fn().mockResolvedValue(timeSeriesSnapshot),
    };
    renderModal(apiClient);
    await waitFor(() => expect(apiClient.gexTermStructure).toHaveBeenCalled());

    screen.getByText('Time Series').click();

    await waitFor(() => expect(apiClient.gexHeatmap).toHaveBeenCalled());
  });

  it('time series requests the chain-selected expiration by default and the chart-matched bucket size', async () => {
    const apiClient = {
      gexTermStructure: vi.fn().mockResolvedValue(termStructureSnapshot),
      gexHeatmap: vi.fn().mockResolvedValue(timeSeriesSnapshot),
    };
    renderModal(apiClient);
    await waitFor(() => expect(apiClient.gexTermStructure).toHaveBeenCalled());

    screen.getByText('Time Series').click();

    await waitFor(() =>
      expect(apiClient.gexHeatmap).toHaveBeenCalledWith(
        'SPY',
        expect.objectContaining({ expiration: '2026-08-21', bucketMinutes: 5 }),
      ),
    );
  });

  it('changing the expiration picker refetches the time series for that expiration', async () => {
    const apiClient = {
      gexTermStructure: vi.fn().mockResolvedValue(termStructureSnapshot),
      gexHeatmap: vi.fn().mockResolvedValue(timeSeriesSnapshot),
    };
    renderModal(apiClient);
    await waitFor(() => expect(apiClient.gexTermStructure).toHaveBeenCalled());
    screen.getByText('Time Series').click();
    await waitFor(() => expect(apiClient.gexHeatmap).toHaveBeenCalledTimes(1));

    const select = screen.getByLabelText('Expiration') as HTMLSelectElement;
    select.value = '2026-08-22';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() =>
      expect(apiClient.gexHeatmap).toHaveBeenLastCalledWith(
        'SPY',
        expect.objectContaining({ expiration: '2026-08-22' }),
      ),
    );
  });

  it('persists the selected view mode to settings', async () => {
    const apiClient = {
      gexTermStructure: vi.fn().mockResolvedValue(termStructureSnapshot),
      gexHeatmap: vi.fn().mockResolvedValue(timeSeriesSnapshot),
    };
    const settingsStore = new SettingsStore();
    expect(settingsStore.gexHeatmapView).toBe('termStructure');
    renderModal(apiClient);
    await waitFor(() => expect(apiClient.gexTermStructure).toHaveBeenCalled());

    screen.getByText('Time Series').click();
    await waitFor(() => expect(apiClient.gexHeatmap).toHaveBeenCalled());

    expect(new SettingsStore().gexHeatmapView).toBe('timeSeries');
  });

  it('shows an error state instead of fabricated exposure data on failure', async () => {
    const apiClient = {
      gexTermStructure: vi.fn().mockRejectedValue(new Error('network down')),
      gexHeatmap: vi.fn(),
    };
    renderModal(apiClient);

    await waitFor(() => expect(screen.getByText(/GEX data unavailable/)).toBeInTheDocument());
  });

  it('renders the header with symbol, price, bid, and ask', async () => {
    const apiClient = {
      gexTermStructure: vi.fn().mockResolvedValue(termStructureSnapshot),
      gexHeatmap: vi.fn().mockResolvedValue(timeSeriesSnapshot),
    };
    renderModal(apiClient);

    expect(screen.getByText('SPY')).toBeInTheDocument();
    expect(screen.getByText('499.95')).toBeInTheDocument();
    expect(screen.getByText('500.05')).toBeInTheDocument();
    await waitFor(() => expect(apiClient.gexTermStructure).toHaveBeenCalled());
  });
});
