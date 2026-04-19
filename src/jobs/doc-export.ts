// Document export — renders markdown to PDF (via puppeteer + print CSS) and
// to DOCX (via the `docx` library). Both return a Buffer the route can stream
// to the browser with a download Content-Disposition.
//
// PDF styling mirrors OpenClaw Mission Control's Documents export: Georgia
// serif body, gold H1 underline, ~1in margins on Letter/A4. Keeps the
// "printable" feel consistent between the two tools.

import {
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import type { IParagraphOptions } from 'docx';
import { marked } from 'marked';
import puppeteer from 'puppeteer';

import { logger } from '../logger.js';

/** Escape the bits of a string that HTML cares about. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapHtmlForPrint(bodyHtml: string, title: string): string {
  const safeTitle = escapeHtml(title || 'Document');
  const generated = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  // Keep the styling self-contained so puppeteer renders identically in dev + prod.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${safeTitle}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 11pt;
    line-height: 1.65;
    color: #1a1a1a;
    margin: 0;
    padding: 0;
  }
  .document {
    padding: 18mm 20mm;
    max-width: 210mm;
    margin: 0 auto;
  }
  h1 {
    font-size: 22pt;
    font-weight: 700;
    margin: 0 0 14pt 0;
    padding-bottom: 6pt;
    border-bottom: 2px solid #D4AF37;
    color: #000;
  }
  h2 { font-size: 15pt; font-weight: 700; margin: 18pt 0 6pt 0; color: #000; }
  h3 { font-size: 12pt; font-weight: 700; margin: 14pt 0 4pt 0; color: #000; }
  p { margin: 0 0 9pt 0; }
  ul, ol { padding-left: 22pt; margin: 0 0 9pt 0; }
  li { margin-bottom: 4pt; }
  code {
    background: #f3f3f3;
    padding: 1px 4px;
    border-radius: 3px;
    font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 10pt;
  }
  pre {
    background: #f3f3f3;
    padding: 10pt 12pt;
    border-radius: 4px;
    overflow-x: auto;
    font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 10pt;
    line-height: 1.5;
  }
  pre code { background: transparent; padding: 0; }
  blockquote {
    border-left: 3pt solid #D4AF37;
    margin: 9pt 0;
    padding: 2pt 0 2pt 14pt;
    color: #333;
    font-style: italic;
  }
  table { width: 100%; border-collapse: collapse; margin: 12pt 0; }
  th, td { padding: 6pt 10pt; border: 1px solid #d0d0d0; text-align: left; }
  th { background: #f5efd7; color: #000; font-weight: 700; }
  hr { border: none; border-top: 1px solid #d0d0d0; margin: 16pt 0; }
  .footer {
    margin-top: 24pt;
    padding-top: 10pt;
    border-top: 1px solid #d0d0d0;
    font-size: 9pt;
    color: #777;
    text-align: center;
  }
</style>
</head>
<body>
<div class="document">
${bodyHtml}
<div class="footer">Generated via ClaudeClaw Mission Control · ${generated}</div>
</div>
</body>
</html>`;
}

/** Render markdown to a PDF Buffer using a headless Chromium instance. */
export async function renderPdf(markdown: string, title: string): Promise<Buffer> {
  const bodyHtml = marked.parse(markdown, { async: false }) as string;
  const html = wrapHtmlForPrint(bodyHtml, title);

  // Production-ready launch flags: new headless, sandbox on when possible,
  // fallback to --no-sandbox on dev Macs where the Chromium sandbox isn't setup.
  const launchArgs: string[] = [
    '--disable-dev-shm-usage',
    '--font-render-hinting=none',
  ];
  if (process.platform === 'darwin') launchArgs.push('--no-sandbox');

  const browser = await puppeteer.launch({
    headless: true,
    args: launchArgs,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'doc-export: browser close failed');
    });
  }
}

// ── DOCX rendering ────────────────────────────────────────────────────
// We translate markdown to a minimal paragraph tree. Not a full markdown
// parser — handles the subset our templates use: headings 1–3, paragraphs,
// bullets / numbered lists, horizontal rules, bold/italic/inline-code runs.

interface DocxLineSpec {
  kind: 'heading' | 'paragraph' | 'bullet' | 'numbered' | 'hr' | 'blank';
  level?: 1 | 2 | 3;
  text?: string;
}

/** Very small line-by-line markdown tokenizer tailored for our templates. */
function tokenizeMarkdown(md: string): DocxLineSpec[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: DocxLineSpec[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '') { out.push({ kind: 'blank' }); continue; }
    if (/^---+$/.test(line)) { out.push({ kind: 'hr' }); continue; }
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) { out.push({ kind: 'heading', level: 1, text: h1[1].trim() }); continue; }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) { out.push({ kind: 'heading', level: 2, text: h2[1].trim() }); continue; }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) { out.push({ kind: 'heading', level: 3, text: h3[1].trim() }); continue; }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) { out.push({ kind: 'bullet', text: bullet[1].trim() }); continue; }
    const numbered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (numbered) { out.push({ kind: 'numbered', text: numbered[1].trim() }); continue; }
    out.push({ kind: 'paragraph', text: line.trim() });
  }
  return out;
}

/** Split inline text into styled TextRun segments. Supports **bold**, *italic*, `code`. */
function buildRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Walk the string once and emit a TextRun per styled segment.
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      runs.push(new TextRun({ text: text.slice(lastIdx, match.index) }));
    }
    if (match[2] != null) runs.push(new TextRun({ text: match[2], bold: true }));
    else if (match[3] != null) runs.push(new TextRun({ text: match[3], italics: true }));
    else if (match[4] != null) runs.push(new TextRun({ text: match[4], font: 'Menlo', color: '444444' }));
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) runs.push(new TextRun({ text: text.slice(lastIdx) }));
  if (runs.length === 0) runs.push(new TextRun({ text }));
  return runs;
}

function makeParagraph(spec: DocxLineSpec): Paragraph | null {
  switch (spec.kind) {
    case 'blank':
      return new Paragraph({ children: [new TextRun({ text: '' })] });
    case 'hr':
      return new Paragraph({
        children: [new TextRun({ text: '' })],
        border: { bottom: { color: 'BBBBBB', space: 1, style: 'single', size: 6 } },
        spacing: { before: 120, after: 120 },
      });
    case 'heading': {
      const level = spec.level ?? 1;
      const levelMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
      const opts: IParagraphOptions = { heading: levelMap[level], children: buildRuns(spec.text ?? '') };
      return new Paragraph(opts);
    }
    case 'bullet':
      return new Paragraph({ bullet: { level: 0 }, children: buildRuns(spec.text ?? '') });
    case 'numbered':
      return new Paragraph({ numbering: { reference: 'docx-numbered', level: 0 }, children: buildRuns(spec.text ?? '') });
    case 'paragraph':
      return new Paragraph({ children: buildRuns(spec.text ?? '') });
    default:
      return null;
  }
}

export async function renderDocx(markdown: string, title: string): Promise<Buffer> {
  const tokens = tokenizeMarkdown(markdown);
  const paragraphs: Paragraph[] = [];

  // Optional doc title at the top if markdown doesn't start with H1.
  const firstToken = tokens.find((t) => t.kind !== 'blank');
  if (firstToken && (firstToken.kind !== 'heading' || firstToken.level !== 1) && title) {
    paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: title })] }));
  }

  for (const t of tokens) {
    const p = makeParagraph(t);
    if (p) paragraphs.push(p);
  }

  const doc = new Document({
    numbering: {
      config: [{
        reference: 'docx-numbered',
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: 'start',
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children: paragraphs,
    }],
  });
  return Packer.toBuffer(doc) as Promise<Buffer>;
}
