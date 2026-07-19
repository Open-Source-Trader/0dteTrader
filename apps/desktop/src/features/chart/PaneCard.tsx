import type { ReactNode } from 'react';

export interface PaneReadout {
  label: string;
  value: string;
  color: string;
}

interface PaneCardProps {
  title: string;
  readouts: PaneReadout[];
  children: ReactNode;
}

/** Chamfered HUD card around a chart sub-pane, with the indicator name and
 *  live value readouts in the header (mockup: `RSI (14) 46.21`). */
export function PaneCard({ title, readouts, children }: PaneCardProps) {
  return (
    <div className="hud-card hud-card--flat" style={{ margin: '0 8px 3px', padding: 0, flex: 'none' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          padding: '3px 8px 0',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-caption2)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span style={{ color: 'var(--app-accent-text)', fontWeight: 600 }}>{title}</span>
        {readouts.map((readout) => (
          <span key={readout.label} style={{ color: readout.color }}>
            {readout.label ? `${readout.label} ` : ''}
            {readout.value}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}
