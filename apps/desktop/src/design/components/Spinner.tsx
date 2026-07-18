interface SpinnerProps {
  size?: number;
  white?: boolean;
}

export function Spinner({ size = 18, white = false }: SpinnerProps) {
  return <span className={`spinner${white ? ' white' : ''}`} style={{ width: size, height: size }} />;
}
