import { useState } from 'react';
import type { Line } from '../lib/msalSnippet';
import { snippetText } from '../lib/msalSnippet';
import { copyText } from '../lib/format';
import { useShell } from '../hooks/useToast';

interface CodeBlockProps {
  lines: Line[];
  ariaLabel: string;
  /** Polite announcement after a successful copy (defaults to the MSAL snippet wording). */
  copyAnnouncement?: string;
  'data-testid'?: string;
}

/** Dark code panel rendering syntax-tinted lines, with a pinned Copy button (copies full text). */
export function CodeBlock({
  lines,
  ariaLabel,
  copyAnnouncement = 'Copied MSAL configuration',
  ...rest
}: CodeBlockProps): JSX.Element {
  const { announce } = useShell();
  const [copied, setCopied] = useState(false);
  const text = snippetText(lines);

  async function onCopy(): Promise<void> {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    announce(copyAnnouncement);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <pre className="code" role="region" aria-label={ariaLabel} data-testid={rest['data-testid']}>
      <button type="button" className="cp" onClick={() => void onCopy()}>
        {copied ? '✓ Copied' : '⧉ Copy'}
      </button>
      {lines.map((line, i) => (
        <span key={i}>
          {line.map((tok, j) => (
            <span key={j} className={tok.k ? `c-${tok.k}` : undefined}>
              {tok.t}
            </span>
          ))}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
