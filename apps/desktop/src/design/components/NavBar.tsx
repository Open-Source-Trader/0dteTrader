import type { ReactNode } from 'react';

interface NavBarProps {
  title?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}

/** 44px inline-title navigation bar. */
export function NavBar({ title, leading, trailing }: NavBarProps) {
  return (
    <div className="navbar">
      {leading ? <div className="navbar-leading">{leading}</div> : null}
      {title ? <span className="navbar-title">{title}</span> : null}
      {trailing ? <div className="navbar-trailing">{trailing}</div> : null}
    </div>
  );
}
