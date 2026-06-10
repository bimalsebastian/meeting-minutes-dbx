/**
 * Extracts structured content from a Genie raw answer markdown string.
 * The LLM consistently produces sections like:
 *   ## Quick Links to Share   (markdown table with [text](url) links)
 *   ## Suggested Next Steps   (numbered list with **Bold**: description items)
 *   ## Key Talking Points     (bullet list)
 *
 * Everything else is treated as supporting prose.
 */

export interface QuickLink {
  text: string;
  url: string;
  description: string;
}

export interface ParsedGenieAnswer {
  quickLinks: QuickLink[];
  nextSteps: string[];       // plain-text step descriptions (bold stripped)
  hasStructuredContent: boolean;
}

// Match markdown links: [text](url)
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

// Match numbered list items: 1. **Bold Title**: description  or  1. plain text
const NUMBERED_ITEM = /^\d+\.\s+(.+)$/;

function stripBold(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').trim();
}

export function parseGenieAnswer(markdown: string | null | undefined): ParsedGenieAnswer {
  if (!markdown) return { quickLinks: [], nextSteps: [], hasStructuredContent: false };

  const quickLinks: QuickLink[] = [];
  const nextSteps: string[] = [];

  // Split on ## headings (keep the heading with its section)
  const sections = markdown.split(/\n(?=##\s)/);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const header = lines[0].toLowerCase();

    // ── Quick Links section ────────────────────────────────────────────────
    if (/quick.?link|link.?shar|resource|reference/i.test(header)) {
      for (const line of lines.slice(1)) {
        MD_LINK.lastIndex = 0;
        const m = MD_LINK.exec(line);
        if (!m) continue;
        const linkText = stripBold(m[1]);
        const url = m[2];
        const cells = line.split('|').map(c => c.trim()).filter(Boolean);
        let description = '';
        for (const cell of cells) {
          if (cell.includes(m[0])) continue;
          const cleaned = cell.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
          if (cleaned && cleaned !== '---') { description = cleaned; break; }
        }
        if (url) quickLinks.push({ text: linkText, url, description });
      }
    }

    // ── Next Steps / Recommendations section ──────────────────────────────
    if (/next.?step|suggested|recommend|action.?item|quick.?win/i.test(header)) {
      for (const line of lines.slice(1)) {
        const m = line.trim().match(NUMBERED_ITEM);
        if (!m) continue;
        const formatted = stripBold(m[1]).replace(/:\s+/, ': ').trim();
        if (formatted) nextSteps.push(formatted);
      }
    }
  }

  // ── Fallback: extract ALL inline markdown links from the full text ────────
  // Used when the answer doesn't have a dedicated Quick Links section.
  if (quickLinks.length === 0) {
    const seen = new Set<string>();
    const globalLink = /\[([^\]]{3,80})\]\((https?:\/\/[^)]{10,300})\)/g;
    let m: RegExpExecArray | null;
    while ((m = globalLink.exec(markdown)) !== null) {
      const text = stripBold(m[1]).trim();
      const url = m[2];
      // Skip bare citation markers like "[1]" and overly generic text
      if (!text || /^\d+$/.test(text)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      // Derive a short description from the URL hostname
      let description = '';
      try { description = new URL(url).hostname.replace('www.', ''); } catch { /* ignore */ }
      quickLinks.push({ text, url, description });
      if (quickLinks.length >= 6) break; // cap at 6 inline links
    }
  }

  return {
    quickLinks,
    nextSteps,
    hasStructuredContent: quickLinks.length > 0 || nextSteps.length > 0,
  };
}
