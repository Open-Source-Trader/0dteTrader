import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LegalMarkdown } from './LegalMarkdown';

describe('LegalMarkdown', () => {
  it('renders repository and support links as safe external anchors', () => {
    const html = renderToStaticMarkup(
      <LegalMarkdown
        markdown={
          '[Source](https://github.com/Open-Source-Trader/0dteTrader) and [support](https://github.com/Open-Source-Trader/0dteTrader/issues)'
        }
      />,
    );

    expect(html).toContain('href="https://github.com/Open-Source-Trader/0dteTrader"');
    expect(html).toContain('href="https://github.com/Open-Source-Trader/0dteTrader/issues"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('does not turn non-HTTP markdown targets into links', () => {
    const html = renderToStaticMarkup(
      <LegalMarkdown markdown="[unsafe](javascript:alert(document.domain))" />,
    );

    expect(html).not.toContain('<a');
    expect(html).toContain('[unsafe](javascript:alert(document.domain))');
  });
});
