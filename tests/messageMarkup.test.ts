import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Every message this bot sends is written in Telegram's HTML flavour and the parse
 * mode is applied centrally in src/bot/index.ts. Markdown syntax mixed into those
 * strings does not render: users saw the literal asterisks instead of bold text.
 */

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const files = sourceFiles(SRC).map(f => ({ file: f, text: fs.readFileSync(f, 'utf8') }));

/** Strips block and line comments so JSDoc markers are not mistaken for markup. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('message markup', () => {
  it('contains no Markdown bold syntax', () => {
    const offenders = files
      .filter(f => /\*\*/.test(withoutComments(f.text)))
      .map(f => path.relative(SRC, f.file));
    expect(offenders, `Markdown bold left in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('contains no Markdown link syntax pointing at Telegram users', () => {
    const offenders = files
      .filter(f => /\]\(tg:\/\/user/.test(f.text))
      .map(f => path.relative(SRC, f.file));
    expect(offenders, `Markdown links left in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('never sets the legacy Markdown parse mode', () => {
    const offenders = files
      .filter(f => /parse_mode:\s*'Markdown'/.test(f.text))
      .map(f => path.relative(SRC, f.file));
    expect(offenders, `legacy parse mode in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('leaves balanced bold tags in every file', () => {
    for (const { file, text } of files) {
      const open = (text.match(/<b>/g) || []).length;
      const close = (text.match(/<\/b>/g) || []).length;
      expect(close, `unbalanced <b> in ${path.relative(SRC, file)}`).toBe(open);
    }
  });

  it('builds Telegram mentions only through the escaping helper', () => {
    const offenders = files
      .filter(f => !f.file.endsWith('html.ts') && /tg:\/\/user\?id=/.test(f.text))
      .map(f => path.relative(SRC, f.file));
    expect(offenders, `hand-built mentions in: ${offenders.join(', ')}`).toEqual([]);
  });
});
