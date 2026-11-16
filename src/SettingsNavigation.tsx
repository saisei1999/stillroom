export type SettingsSection = 'appearance' | 'availability' | 'account' | 'data' | 'about';

const sections: { id: SettingsSection; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'availability', label: 'Availability' },
  { id: 'account', label: 'Account' },
  { id: 'data', label: 'Your data' },
  { id: 'about', label: 'About & credits' },
];

export function SettingsNavigation({ selected, onSelect, onBack }: {
  selected: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  return <nav className="settings-navigation" aria-label="Settings navigation">
    <button type="button" className="settings-back" onClick={onBack}>← Back to library</button>
    <h2>Settings</h2>
    <div className="settings-nav-items">{sections.map(section =>
      <button type="button" key={section.id} aria-current={selected === section.id ? 'page' : undefined} onClick={() => onSelect(section.id)}>{section.label}</button>
    )}</div>
  </nav>;
}
