import type { DesktopCommand } from '../core/desktop/desktopShell';

declare global {
  interface Window {
    desktopShell?: {
      onCommand(handler: (command: DesktopCommand) => void): () => void;
    };
  }
}

export {};
