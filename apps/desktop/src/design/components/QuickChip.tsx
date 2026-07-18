interface QuickChipProps {
  title: string;
  onClick: () => void;
}

/** Small capsule button for quantity quick-steppers (1 / 5 / 10). */
export function QuickChip({ title, onClick }: QuickChipProps) {
  return (
    <button className="quick-chip" onClick={onClick}>
      {title}
    </button>
  );
}
