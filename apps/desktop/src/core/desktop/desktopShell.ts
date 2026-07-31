export type DesktopCommand =
  | { type: 'open-server-selector'; url?: string }
  | { type: 'open-trade-symbol'; symbol: string; interval?: string | null };

interface DesktopShellBridge {
  onCommand(handler: (command: DesktopCommand) => void): () => void;
}

export function getDesktopShell(): DesktopShellBridge | null {
  if (typeof window === 'undefined') return null;
  return window.desktopShell ?? null;
}
