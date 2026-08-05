import type { CSSProperties, ReactNode } from 'react';

const SAFE_MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gi;

function legalMarkdownNodes(markdown: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of markdown.matchAll(SAFE_MARKDOWN_LINK)) {
    const index = match.index;
    if (index > cursor) nodes.push(markdown.slice(cursor, index));

    const label = match[1];
    const href = match[2];
    nodes.push(
      <a key={`${index}:${href}`} href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>,
    );
    cursor = index + match[0].length;
  }

  if (cursor < markdown.length) nodes.push(markdown.slice(cursor));
  return nodes;
}

export function LegalMarkdown({ markdown, style }: { markdown: string; style?: CSSProperties }) {
  return <div style={{ whiteSpace: 'pre-wrap', ...style }}>{legalMarkdownNodes(markdown)}</div>;
}
