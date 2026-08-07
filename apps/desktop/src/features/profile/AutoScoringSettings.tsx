import { useEffect, useState, type FormEvent } from 'react';
import type { AutoScoringPreferenceRecord } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { autoScoringPresetUpdate, customAutoScoringUpdate } from './autoScoringPresets';

type NumericPreferenceKey =
  | 'targetAbsDelta'
  | 'strikeRungs'
  | 'maxSpreadBps'
  | 'maxPremiumDollars'
  | 'minOpenInterest'
  | 'deltaWeight'
  | 'spreadWeight'
  | 'openInterestWeight'
  | 'gammaWeight'
  | 'ivWeight';

export function AutoScoringSettings({
  apiClient,
  onSaved,
}: {
  apiClient: ApiClient;
  onSaved?: () => void | Promise<void>;
}) {
  const [preference, setPreference] = useState<AutoScoringPreferenceRecord | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .autoScoringPreferences()
      .then((record) => {
        if (!cancelled) setPreference(record);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const selectPreset = async (preset: 'conservative' | 'aggressive') => {
    if (!preference || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await apiClient.updateAutoScoringPreferences(
        autoScoringPresetUpdate(preset, preference),
      );
      setPreference(saved);
      await onSaved?.();
      setMessage('Scored Auto preset saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const saveCustom = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!preference || busy) return;
    const update = customAutoScoringUpdate(preference);
    if (!update) {
      setMessage('Enter values within the shown limits; at least one weight must be positive.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const saved = await apiClient.updateAutoScoringPreferences(update);
      setPreference(saved);
      await onSaved?.();
      setMessage('Custom Scored Auto settings saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const updateNumber = (key: NumericPreferenceKey, value: string) => {
    const number = Number(value);
    setPreference((current) =>
      current ? { ...current, preset: 'custom', [key]: number } : current,
    );
    setMessage(null);
  };

  return (
    <div className="grouped-section" aria-label="Scored Auto preferences">
      <div className="section-header">Scored Auto</div>
      <div className="section-card">
        <div className="grouped-row">
          <span>Ranking preset</span>
          <span className="row-value" role="status" aria-live="polite">
            {busy ? 'Loading…' : (preference?.preset ?? 'Unavailable')}
          </span>
        </div>
        <div className="grouped-row" role="group" aria-label="Scored Auto preset">
          {(['conservative', 'aggressive'] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              className="button-row"
              disabled={busy || !preference}
              aria-pressed={preference?.preset === preset}
              onClick={() => void selectPreset(preset)}
            >
              {preset === 'conservative' ? 'Conservative' : 'Aggressive'}
            </button>
          ))}
        </div>
        {preference ? (
          <form
            onSubmit={(event) => void saveCustom(event)}
            aria-label="Custom Scored Auto settings"
          >
            {(
              [
                ['targetAbsDelta', 'Target absolute delta', 0.01, 0.99, 0.01],
                ['strikeRungs', 'Strike rungs', 0, 20, 1],
                ['maxSpreadBps', 'Maximum spread bps', 0, 10_000, 1],
                ['maxPremiumDollars', 'Maximum premium dollars', 0.01, 1_000_000, 0.01],
                ['minOpenInterest', 'Minimum open interest', 0, 1_000_000_000, 1],
                ['deltaWeight', 'Delta weight', 0, 1, 0.05],
                ['spreadWeight', 'Spread weight', 0, 1, 0.05],
                ['openInterestWeight', 'Open interest weight', 0, 1, 0.05],
                ['gammaWeight', 'Gamma weight', 0, 1, 0.05],
                ['ivWeight', 'IV weight', 0, 1, 0.05],
              ] as const
            ).map(([key, label, min, max, step]) => (
              <label className="grouped-row" key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  aria-label={label}
                  min={min}
                  max={max}
                  step={step}
                  value={preference[key] as number}
                  onChange={(event) => updateNumber(key, event.target.value)}
                />
              </label>
            ))}
            <label className="grouped-row">
              <span>Gamma preference</span>
              <select
                aria-label="Gamma preference"
                value={preference.gammaMode}
                onChange={(event) =>
                  setPreference((current) =>
                    current
                      ? {
                          ...current,
                          preset: 'custom',
                          gammaMode: event.target.value === 'seek' ? 'seek' : 'avoid',
                        }
                      : current,
                  )
                }
              >
                <option value="avoid">Avoid gamma</option>
                <option value="seek">Seek gamma</option>
              </select>
            </label>
            <div className="grouped-row">
              <button type="submit" className="button-row" disabled={busy}>
                Save custom settings
              </button>
            </div>
          </form>
        ) : null}
        <div className="grouped-row footnote">
          Fresh quotes and analytics are ranked again when the final order is confirmed.
        </div>
        {message ? (
          <div className="grouped-row footnote" role="status">
            {message}
          </div>
        ) : null}
      </div>
    </div>
  );
}
