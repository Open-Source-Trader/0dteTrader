import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  IVAlertConfiguration,
  IVAlertConfigurationState,
  IVAlertSymbol,
} from '@0dtetrader/shared-types';
import type { QuoteSocket } from '../../core/api/QuoteSocket';
import { isIVAlertConfiguration } from '../../core/api/QuoteSocketDecoder';
import { useStore } from '../../core/observable';
import { Toggle } from '../../design/components/Toggle';

const ALERT_SYMBOLS: readonly IVAlertSymbol[] = ['SPX', 'NDX', 'RUT'];

interface IvAlertDraft {
  enabled: boolean;
  symbols: IVAlertSymbol[];
  lookbackMinutes: string;
  thresholdK: string;
  consecutiveBreaches: string;
  warmupMinutes: string;
  warmupSamples: string;
  cooldownMinutes: string;
}

type NumericDraftKey = Exclude<keyof IvAlertDraft, 'enabled' | 'symbols'>;

function draftFromConfiguration(configuration: IVAlertConfigurationState): IvAlertDraft {
  return {
    enabled: configuration.enabled,
    symbols: [...configuration.symbols],
    lookbackMinutes: String(configuration.lookbackMinutes),
    thresholdK: String(configuration.thresholdK),
    consecutiveBreaches: String(configuration.consecutiveBreaches),
    warmupMinutes: String(configuration.warmupMinutes),
    warmupSamples: String(configuration.warmupSamples),
    cooldownMinutes: String(configuration.cooldownMinutes),
  };
}

function configurationFromDraft(draft: IvAlertDraft): IVAlertConfiguration | null {
  const numericValues = [
    draft.lookbackMinutes,
    draft.thresholdK,
    draft.consecutiveBreaches,
    draft.warmupMinutes,
    draft.warmupSamples,
    draft.cooldownMinutes,
  ];
  if (numericValues.some((value) => value.trim() === '')) return null;
  const candidate: IVAlertConfiguration = {
    enabled: draft.enabled,
    symbols: [...draft.symbols],
    lookbackMinutes: Number(draft.lookbackMinutes),
    thresholdK: Number(draft.thresholdK),
    consecutiveBreaches: Number(draft.consecutiveBreaches),
    warmupMinutes: Number(draft.warmupMinutes),
    warmupSamples: Number(draft.warmupSamples),
    cooldownMinutes: Number(draft.cooldownMinutes),
  };
  return isIVAlertConfiguration(candidate) ? candidate : null;
}

function configurationsMatch(
  received: IVAlertConfigurationState,
  submitted: IVAlertConfiguration,
): boolean {
  return (
    received.enabled === submitted.enabled &&
    received.lookbackMinutes === submitted.lookbackMinutes &&
    received.thresholdK === submitted.thresholdK &&
    received.consecutiveBreaches === submitted.consecutiveBreaches &&
    received.warmupMinutes === submitted.warmupMinutes &&
    received.warmupSamples === submitted.warmupSamples &&
    received.cooldownMinutes === submitted.cooldownMinutes &&
    received.symbols.length === submitted.symbols.length &&
    received.symbols.every((symbol) => submitted.symbols.includes(symbol))
  );
}

function NumberSetting({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grouped-row">
      <span>{label}</span>
      <input
        className="iv-alert-number-input"
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function IvAlertSettings({ socket }: { socket: QuoteSocket }) {
  const socketState = useStore(socket);
  const received = socketState.ivAlertConfiguration;
  const [draft, setDraft] = useState<IvAlertDraft | null>(() =>
    received ? draftFromConfiguration(received) : null,
  );
  const pendingConfiguration = useRef<{
    configuration: IVAlertConfiguration;
    previousErrorSequence: number;
  } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackIsError, setFeedbackIsError] = useState(false);

  useEffect(() => {
    if (!received) return;
    setDraft(draftFromConfiguration(received));
    const pending = pendingConfiguration.current;
    if (pending !== null) {
      pendingConfiguration.current = null;
      if (configurationsMatch(received, pending.configuration)) {
        setFeedback('Alert settings saved.');
        setFeedbackIsError(false);
      } else {
        setFeedback('Server did not apply these alert settings. Review them and retry.');
        setFeedbackIsError(true);
      }
    }
  }, [received]);

  useEffect(() => {
    const pending = pendingConfiguration.current;
    const error = socketState.lastServerError;
    if (
      pending === null ||
      error === null ||
      error.sequence <= pending.previousErrorSequence ||
      error.code !== 'IV_ALERT_CONFIGURATION_INVALID'
    ) {
      return;
    }
    pendingConfiguration.current = null;
    setFeedback(`Server rejected these alert settings: ${error.message}`);
    setFeedbackIsError(true);
  }, [socketState.lastServerError]);

  const validated = useMemo(() => (draft ? configurationFromDraft(draft) : null), [draft]);
  let validationMessage: string | null = null;
  if (draft?.symbols.length === 0) {
    validationMessage = 'Choose at least one symbol.';
  } else if (draft && validated === null) {
    validationMessage = 'Enter valid values within the shown limits.';
  }

  if (!draft || !received) {
    return (
      <div className="grouped-section">
        <div className="section-header">ATM IV Alerts</div>
        <div className="section-card">
          <div className="grouped-row footnote text-secondary" role="status">
            Waiting for alert settings from the server.
          </div>
        </div>
      </div>
    );
  }

  const updateNumber = (key: NumericDraftKey) => (value: string) => {
    setFeedback(null);
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const toggleSymbol = (symbol: IVAlertSymbol): void => {
    setFeedback(null);
    setDraft((current) => {
      if (!current) return current;
      const selected = current.symbols.includes(symbol)
        ? current.symbols.filter((candidate) => candidate !== symbol)
        : [...current.symbols, symbol];
      return {
        ...current,
        symbols: ALERT_SYMBOLS.filter((candidate) => selected.includes(candidate)),
      };
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!validated) return;
    if (!socket.configureIvAlerts(validated)) {
      pendingConfiguration.current = null;
      setFeedback('Live stream is disconnected. Reconnect before saving alert settings.');
      setFeedbackIsError(true);
      return;
    }
    pendingConfiguration.current = {
      configuration: { ...validated, symbols: [...validated.symbols] },
      previousErrorSequence: socketState.lastServerError?.sequence ?? 0,
    };
    setFeedback('Alert settings sent. Waiting for server confirmation.');
    setFeedbackIsError(false);
  };

  return (
    <div className="grouped-section" aria-labelledby="iv-alert-settings-title">
      <div className="section-header" id="iv-alert-settings-title">
        ATM IV Alerts
      </div>
      <form className="section-card" onSubmit={submit} noValidate>
        <div className="grouped-row">
          <span>Enable anomaly alerts</span>
          <span style={{ marginLeft: 'auto' }}>
            <Toggle
              on={draft.enabled}
              ariaLabel="Enable ATM IV alerts"
              onChange={(enabled) => {
                setFeedback(null);
                setDraft((current) => (current ? { ...current, enabled } : current));
              }}
            />
          </span>
        </div>
        <div className="grouped-row">
          <span id="iv-alert-symbols-label">Symbols</span>
          <span
            role="group"
            aria-labelledby="iv-alert-symbols-label"
            style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}
          >
            {ALERT_SYMBOLS.map((symbol) => (
              <label key={symbol}>
                <input
                  type="checkbox"
                  aria-label={`${symbol} alerts`}
                  checked={draft.symbols.includes(symbol)}
                  onChange={() => toggleSymbol(symbol)}
                />{' '}
                {symbol}
              </label>
            ))}
          </span>
        </div>
        <NumberSetting
          label="Lookback minutes"
          value={draft.lookbackMinutes}
          min={5}
          max={240}
          step={1}
          onChange={updateNumber('lookbackMinutes')}
        />
        <NumberSetting
          label="Anomaly threshold"
          value={draft.thresholdK}
          min={0.1}
          max={20}
          step={0.1}
          onChange={updateNumber('thresholdK')}
        />
        <NumberSetting
          label="Consecutive breaches"
          value={draft.consecutiveBreaches}
          min={1}
          max={10}
          step={1}
          onChange={updateNumber('consecutiveBreaches')}
        />
        <NumberSetting
          label="Warmup minutes"
          value={draft.warmupMinutes}
          min={0}
          max={60}
          step={1}
          onChange={updateNumber('warmupMinutes')}
        />
        <NumberSetting
          label="Warmup samples"
          value={draft.warmupSamples}
          min={1}
          max={240}
          step={1}
          onChange={updateNumber('warmupSamples')}
        />
        <NumberSetting
          label="Cooldown minutes"
          value={draft.cooldownMinutes}
          min={0}
          max={1440}
          step={1}
          onChange={updateNumber('cooldownMinutes')}
        />
        {validationMessage ? (
          <div className="grouped-row footnote negative" role="alert">
            {validationMessage}
          </div>
        ) : null}
        {feedback ? (
          <div
            className={`grouped-row footnote${feedbackIsError ? ' negative' : ' positive'}`}
            role={feedbackIsError ? 'alert' : 'status'}
          >
            {feedback}
          </div>
        ) : null}
        <button type="submit" className="grouped-row button-row" disabled={validated === null}>
          Save ATM IV alert settings
        </button>
      </form>
      <div className="section-footer">
        Settings are saved to your account. Alerts use SPX, NDX, and RUT ATM implied volatility.
      </div>
    </div>
  );
}
