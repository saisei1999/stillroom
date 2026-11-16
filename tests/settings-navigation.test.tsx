import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsNavigation } from '../src/SettingsNavigation';

describe('settings navigation', () => {
  it('exposes focused sections and marks the selected destination', () => {
    const html = renderToStaticMarkup(<SettingsNavigation selected="account" onSelect={() => {}} onBack={() => {}} />);
    expect(html).toContain('aria-label="Settings navigation"');
    expect(html).toContain('Appearance');
    expect(html).toContain('Availability');
    expect(html).toContain('Account');
    expect(html).toContain('Your data');
    expect(html).toContain('About &amp; credits');
    expect(html).toMatch(/aria-current="page"[^>]*>[^<]*Account/);
  });
});
