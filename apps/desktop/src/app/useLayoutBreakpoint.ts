import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export type LayoutBreakpoint = 'compact' | 'standard' | 'wide';

export const BREAKPOINT_STANDARD_MIN = 1024;
export const BREAKPOINT_WIDE_MIN = 1600;

/** Trading-desk breakpoints: below `standard` the app keeps the existing
 *  stacked phone-derived layout; `standard`/`wide` unlock the multi-pane grid. */
export function breakpointForWidth(width: number): LayoutBreakpoint {
  if (width >= BREAKPOINT_WIDE_MIN) return 'wide';
  if (width >= BREAKPOINT_STANDARD_MIN) return 'standard';
  return 'compact';
}

/** Tracks the app shell's own box width (not window.innerWidth) so the grid
 *  reflows correctly even when embedded at a non-window size. */
export function useLayoutBreakpoint(): [RefObject<HTMLDivElement | null>, LayoutBreakpoint] {
  const ref = useRef<HTMLDivElement>(null);
  const [breakpoint, setBreakpoint] = useState<LayoutBreakpoint>('compact');

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setBreakpoint(breakpointForWidth(entry.contentRect.width));
    });
    observer.observe(element);
    setBreakpoint(breakpointForWidth(element.clientWidth));
    return () => observer.disconnect();
  }, []);

  return [ref, breakpoint];
}
