import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandMark } from '../src/BrandMark';

describe('brand mark', () => {
  it('renders the compact geometry for small sizes and stays decorative by default', () => {
    const html = renderToStaticMarkup(<BrandMark size={22} compact />);
    expect(html).toContain('viewBox="0 0 32 32"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toContain('<title>');
  });

  it('renders the full geometry with an accessible title when named', () => {
    const html = renderToStaticMarkup(<BrandMark title="Stillroom" />);
    expect(html).toContain('viewBox="0 0 100 100"');
    expect(html).toContain('role="img"');
    expect(html).toContain('<title>Stillroom</title>');
  });
});
