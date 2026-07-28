import type { ReactNode } from 'react';

interface NavBarProps {
  title?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Extra class, e.g. `navbar-desktop` for the tighter desktop-grid density. */
  className?: string;
}

/** 44px inline-title navigation bar. */
export function NavBar({ title, leading, trailing, className }: NavBarProps) {
  return (
    <div className={className ? `navbar ${className}` : 'navbar'}>
      {leading ? <div className="navbar-leading">{leading}</div> : null}
      {title ? <span className="navbar-title">{title}</span> : null}
      {trailing ? <div className="navbar-trailing">{trailing}</div> : null}
    </div>
  );
}
