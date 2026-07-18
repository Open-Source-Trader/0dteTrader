import { useEffect, useState } from 'react';

interface SpinnerProps {
  size?: number;
  white?: boolean;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function Spinner({ size = 18, white = false }: SpinnerProps) {
  // Under reduced motion the rotation is swapped for an opacity pulse
  // (.spinner.reduced in components.css).
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION_QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return (
    <span
      className={`spinner${white ? ' white' : ''}${reduced ? ' reduced' : ''}`}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}
