import { useState } from 'react';
import type { ReactNode } from 'react';
import { DesktopSheet } from './DesktopSheet';

export interface DesktopSettingsTab {
  key: string;
  label: string;
  icon: ReactNode;
  content: ReactNode;
}

interface DesktopSettingsPanelProps {
  tabs: DesktopSettingsTab[];
  initialTabKey?: string;
  onDismiss: () => void;
}

/**
 * Unified desktop settings window: sidebar tabs + content pane, macOS
 * System Settings / VS Code Settings convention. Replaces two separate
 * iOS-style sheets (Profile, Indicators) with one window — each tab's
 * `content` is that view's existing body markup, unmodified logic, just
 * embedded here instead of wrapped in its own Sheet/NavBar.
 */
export function DesktopSettingsPanel({
  tabs,
  initialTabKey,
  onDismiss,
}: DesktopSettingsPanelProps) {
  const [activeKey, setActiveKey] = useState(initialTabKey ?? tabs[0]?.key);
  const active = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];

  return (
    <DesktopSheet onDismiss={onDismiss}>
      <div className="desktop-settings-panel">
        <div className="desktop-settings-sidebar" role="tablist" aria-label="Settings">
          <div className="desktop-settings-sidebar-title">Settings</div>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={tab.key === active?.key}
              className={
                tab.key === active?.key ? 'desktop-settings-tab active' : 'desktop-settings-tab'
              }
              onClick={() => setActiveKey(tab.key)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        <div className="desktop-settings-content">
          <div className="desktop-settings-content-header">
            <span>{active?.label}</span>
            <button
              className="navbar-text-button"
              style={{ marginLeft: 'auto' }}
              onClick={onDismiss}
              aria-label="Close settings"
            >
              Done
            </button>
          </div>
          <div className="desktop-settings-body hide-scrollbar">{active?.content}</div>
        </div>
      </div>
    </DesktopSheet>
  );
}
