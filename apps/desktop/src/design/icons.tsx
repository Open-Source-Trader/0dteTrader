import type { CSSProperties } from 'react';

/** Inline SVG stand-ins for the SF Symbols used by the iOS app. */
interface IconProps {
  size?: number;
  style?: CSSProperties;
}

function svgProps(size: number, style?: CSSProperties) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { flexShrink: 0, ...style },
  };
}

export function PersonCircleIcon({ size = 22, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.5 19a6.5 6.5 0 0 1 11 0" />
    </svg>
  );
}

export function LayoutSplitIcon({ size = 20, style }: IconProps) {
  // rectangle.split.1x2
  return (
    <svg {...svgProps(size, style)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <line x1="4" y1="13" x2="20" y2="13" />
    </svg>
  );
}

export function LayoutFullIcon({ size = 20, style }: IconProps) {
  // rectangle
  return (
    <svg {...svgProps(size, style)}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 12, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)} strokeWidth={3}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function CalendarIcon({ size = 13, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <line x1="16" y1="3" x2="16" y2="7" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

export function ChartLineIcon({ size = 13, style }: IconProps) {
  // chart.line.uptrend.xyaxis
  return (
    <svg {...svgProps(size, style)}>
      <path d="M3 3v18h18" />
      <polyline points="6 15 10 10 14 12 20 5" />
    </svg>
  );
}

export function BoxIcon({ size = 13, style }: IconProps) {
  // shippingbox
  return (
    <svg {...svgProps(size, style)}>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <line x1="12" y1="22" x2="12" y2="12" />
    </svg>
  );
}

export function DocIcon({ size = 13, style }: IconProps) {
  // doc.text
  return (
    <svg {...svgProps(size, style)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  );
}

export function SlidersIcon({ size = 15, style }: IconProps) {
  // slider.horizontal.3
  return (
    <svg {...svgProps(size, style)}>
      <line x1="3" y1="7" x2="21" y2="7" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="17" x2="21" y2="17" />
      <circle cx="15" cy="7" r="2.4" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <circle cx="17" cy="17" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CheckmarkIcon({ size = 14, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)} strokeWidth={2.5}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function CheckCircleFillIcon({ size = 15, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)} stroke="none" fill="currentColor">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm5.03 7.03-6 6a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06l2.47 2.47 5.47-5.47a.75.75 0 1 1 1.06 1.06Z" />
    </svg>
  );
}

export function XCircleFillIcon({ size = 17, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)} stroke="none" fill="currentColor">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.53 12.47a.75.75 0 1 1-1.06 1.06L12 13.06l-2.47 2.47a.75.75 0 0 1-1.06-1.06L10.94 12 8.47 9.53a.75.75 0 0 1 1.06-1.06L12 10.94l2.47-2.47a.75.75 0 1 1 1.06 1.06L13.06 12Z" />
    </svg>
  );
}

export function WarningIcon({ size = 14, style }: IconProps) {
  // exclamationmark.triangle
  return (
    <svg {...svgProps(size, style)}>
      <path d="m10.29 3.86-8.18 14.14a2 2 0 0 0 1.73 3h16.32a2 2 0 0 0 1.73-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <circle cx="12" cy="17" r="0.5" fill="currentColor" />
    </svg>
  );
}

export function WarningFillIcon({ size = 14, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)} stroke="none" fill="currentColor">
      <path d="M13.73 3.36a2 2 0 0 0-3.46 0L1.9 17.86A2 2 0 0 0 3.63 21h16.74a2 2 0 0 0 1.73-3.14ZM12 9a.9.9 0 0 1 .9.9v3.7a.9.9 0 0 1-1.8 0V9.9A.9.9 0 0 1 12 9Zm0 9.2a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Z" />
    </svg>
  );
}

export function InfoCircleFillIcon({ size = 14, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)} stroke="none" fill="currentColor">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.4a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Zm1.5 11.1h-3a.75.75 0 0 1 0-1.5h.75v-4h-.75a.75.75 0 0 1 0-1.5H12a.75.75 0 0 1 .75.75V16h.75a.75.75 0 0 1 0 1.5Z" />
    </svg>
  );
}

export function PlusIcon({ size = 14, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function MinusIcon({ size = 14, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function MagnifierIcon({ size = 14, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  );
}

export function TextCursorIcon({ size = 14, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)}>
      <path d="M9 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9" />
      <path d="M15 4h-2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2" />
      <line x1="12" y1="8" x2="12" y2="16" />
    </svg>
  );
}

/* Cosmetic status-bar glyphs */
export function CellularIcon({ size = 17, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)} stroke="none" fill="currentColor">
      <rect x="2" y="14" width="3.4" height="5" rx="1" />
      <rect x="7.2" y="11.5" width="3.4" height="7.5" rx="1" />
      <rect x="12.4" y="8.5" width="3.4" height="10.5" rx="1" />
      <rect x="17.6" y="5" width="3.4" height="14" rx="1" />
    </svg>
  );
}

export function WifiIcon({ size = 16, style }: IconProps) {
  return (
    <svg {...svgProps(size, style)} strokeWidth={2.2}>
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M8.53 15.61a6 6 0 0 1 6.95 0" />
      <circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BatteryIcon({ size = 24, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size * 0.5}
      viewBox="0 0 28 14"
      fill="none"
      style={{ flexShrink: 0, ...style }}
    >
      <rect x="1" y="1" width="22" height="12" rx="3.5" stroke="currentColor" opacity="0.4" />
      <rect x="3" y="3" width="16" height="8" rx="2" fill="currentColor" />
      <path d="M25 5v4a2.2 2.2 0 0 0 0-4Z" fill="currentColor" opacity="0.4" />
    </svg>
  );
}
