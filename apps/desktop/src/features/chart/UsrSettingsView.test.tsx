// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsrSettingsBody } from './UsrSettingsView';
import { DEFAULT_USR_SETTINGS } from './ultimateSupportResistance/usrSettings';

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('UsrSettingsBody validated text drafts', () => {
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

  it('rejects an invalid custom timeframe without replacing the live setting', () => {
    const onChange = vi.fn();
    const settings = { ...DEFAULT_USR_SETTINGS, analysisTimeframe: 'custom' as const };
    act(() => root.render(<UsrSettingsBody settings={settings} onChange={onChange} />));
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Ultimate S/R custom timeframe"]',
    )!;

    act(() => {
      input.focus();
      setInput(input, '1H');
      input.blur();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('60');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    act(() => {
      input.focus();
      setInput(input, ' d ');
      input.blur();
    });
    expect(onChange).toHaveBeenCalledWith({ ...settings, customTimeframe: 'D' });
  });

  it('rejects malformed colors and commits a canonical trimmed valid value', () => {
    const onChange = vi.fn();
    act(() => root.render(<UsrSettingsBody settings={DEFAULT_USR_SETTINGS} onChange={onChange} />));
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Ultimate S/R Bullish FVG Color"]',
    )!;

    act(() => {
      input.focus();
      setInput(input, 'rgb(1,,3)');
      input.blur();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe(DEFAULT_USR_SETTINGS.fvgBullishColor);

    act(() => {
      input.focus();
      setInput(input, ' #A1B2C3 ');
      input.blur();
    });
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_USR_SETTINGS,
      fvgBullishColor: '#A1B2C3',
    });
  });

  it('rejects fractional integer settings before they reach the model', () => {
    const onChange = vi.fn();
    act(() => root.render(<UsrSettingsBody settings={DEFAULT_USR_SETTINGS} onChange={onChange} />));
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Ultimate S/R Pivot Left Bars"]',
    )!;

    act(() => {
      input.focus();
      setInput(input, '2.5');
      input.blur();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe(String(DEFAULT_USR_SETTINGS.pivotLeftBars));
    expect(input.getAttribute('aria-invalid')).toBe('true');

    act(() => {
      input.focus();
      setInput(input, '2');
      input.blur();
    });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_USR_SETTINGS, pivotLeftBars: 2 });
  });
});
