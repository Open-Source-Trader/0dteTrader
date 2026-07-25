import type { TwcHeatmapSettings } from './twc/twcSettings';
import { buildTwcSections } from './twcSections';

interface TwcSettingsBodyProps {
  settings: TwcHeatmapSettings;
  onChange: (settings: TwcHeatmapSettings) => void;
}

/** Just the section rows, concatenated — reused standalone (compact Sheet)
 *  and inline inside the Indicators tab's Scripts section on desktop grid. */
export function TwcSettingsBody({ settings, onChange }: TwcSettingsBodyProps) {
  const sections = buildTwcSections(settings, onChange);
  return (
    <div className="grouped-list hide-scrollbar">
      {sections.map((s) => (
        <div key={s.id}>{s.content}</div>
      ))}
    </div>
  );
}
