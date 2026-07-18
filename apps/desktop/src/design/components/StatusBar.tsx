import { useEffect, useState } from 'react';
import { BatteryIcon, CellularIcon, WifiIcon } from '../icons';

function formatTime(date: Date): string {
  const h = date.getHours() % 12 || 12;
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Cosmetic iPhone status bar with Dynamic Island. */
export function StatusBar() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="status-bar">
      <span className="time">{formatTime(now)}</span>
      <div className="island" />
      <div className="glyphs">
        <CellularIcon />
        <WifiIcon />
        <BatteryIcon />
      </div>
    </div>
  );
}
