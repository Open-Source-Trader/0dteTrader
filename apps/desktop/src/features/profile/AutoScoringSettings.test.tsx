// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoScoringPreferenceRecord } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { AutoScoringSettings } from './AutoScoringSettings';
import { autoScoringPresetUpdate, customAutoScoringUpdate } from './autoScoringPresets';

const preference: AutoScoringPreferenceRecord = {
  schemaVersion: 1,
  preset: 'conservative',
  targetAbsDelta: 0.25,
  strikeRungs: 5,
  maxSpreadBps: 500,
  maxPremiumDollars: 250,
  minOpenInterest: 100,
  gammaMode: 'avoid',
  deltaWeight: 0.3,
  spreadWeight: 0.25,
  openInterestWeight: 0.2,
  gammaWeight: 0.1,
  ivWeight: 0.15,
  createdAt: '2026-08-05T14:00:00.000Z',
  updatedAt: '2026-08-05T14:00:00.000Z',
};

describe('AutoScoringSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('builds the exact aggressive preset with optimistic concurrency', () => {
    expect(autoScoringPresetUpdate('aggressive', preference)).toEqual({
      schemaVersion: 1,
      preset: 'aggressive',
      targetAbsDelta: 0.4,
      strikeRungs: 8,
      maxSpreadBps: 1_000,
      maxPremiumDollars: 500,
      minOpenInterest: 25,
      gammaMode: 'seek',
      deltaWeight: 0.25,
      spreadWeight: 0.15,
      openInterestWeight: 0.15,
      gammaWeight: 0.3,
      ivWeight: 0.15,
      expectedUpdatedAt: preference.updatedAt,
    });
  });

  it('builds an exact validated custom update and rejects a zero weight total', () => {
    expect(customAutoScoringUpdate({ ...preference, preset: 'custom' })).toEqual({
      schemaVersion: 1,
      preset: 'custom',
      targetAbsDelta: 0.25,
      strikeRungs: 5,
      maxSpreadBps: 500,
      maxPremiumDollars: 250,
      minOpenInterest: 100,
      gammaMode: 'avoid',
      deltaWeight: 0.3,
      spreadWeight: 0.25,
      openInterestWeight: 0.2,
      gammaWeight: 0.1,
      ivWeight: 0.15,
      expectedUpdatedAt: preference.updatedAt,
    });
    expect(
      customAutoScoringUpdate({
        ...preference,
        deltaWeight: 0,
        spreadWeight: 0,
        openInterestWeight: 0,
        gammaWeight: 0,
        ivWeight: 0,
      }),
    ).toBeNull();
  });

  it('loads the user preference and persists a selected preset', async () => {
    const update = vi.fn(async () => ({ ...preference, preset: 'aggressive' as const }));
    const onSaved = vi.fn();
    const apiClient = {
      autoScoringPreferences: async () => preference,
      updateAutoScoringPreferences: update,
    } as unknown as ApiClient;

    await act(async () => {
      root.render(<AutoScoringSettings apiClient={apiClient} onSaved={onSaved} />);
    });
    const aggressive = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Aggressive',
    );
    await act(async () => aggressive?.click());

    expect(update).toHaveBeenCalledWith(autoScoringPresetUpdate('aggressive', preference));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('aggressive');
  });

  it('submits the shipped premium through native form validation and refreshes active scoring', async () => {
    const update = vi.fn(async () => ({ ...preference, preset: 'custom' as const }));
    const onSaved = vi.fn();
    const apiClient = {
      autoScoringPreferences: async () => preference,
      updateAutoScoringPreferences: update,
    } as unknown as ApiClient;

    await act(async () => {
      root.render(<AutoScoringSettings apiClient={apiClient} onSaved={onSaved} />);
    });
    const form = container.querySelector<HTMLFormElement>('form');
    const premium = container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum premium dollars"]',
    );
    expect(premium?.value).toBe('250');
    expect(premium?.validity.stepMismatch).toBe(false);
    expect(form?.checkValidity()).toBe(true);

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(),
    );

    expect(update).toHaveBeenCalledWith(customAutoScoringUpdate(preference));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('surfaces an optimistic-concurrency conflict from a custom save', async () => {
    const apiClient = {
      autoScoringPreferences: async () => preference,
      updateAutoScoringPreferences: async () => {
        throw new Error('Auto scoring preferences changed; reload before saving again.');
      },
    } as unknown as ApiClient;

    await act(async () => {
      root.render(<AutoScoringSettings apiClient={apiClient} />);
    });
    const form = container.querySelector('form');
    await act(async () =>
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );

    expect(container.textContent).toContain('changed; reload before saving again');
  });
});
