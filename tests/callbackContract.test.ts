import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Callback data is a string contract between the code that builds an inline button
 * and the code that handles the resulting callback query. Nothing in the type system
 * checks that the two sides agree, and when they drifted apart the admin's
 * "approve receipt" button silently did nothing, stranding every paid deal.
 *
 * These tests re-derive both sides from the source and assert they still line up.
 */

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const sources = sourceFiles(SRC).map(f => fs.readFileSync(f, 'utf8'));
const allSource = sources.join('\n');

/** Callback data strings passed to Markup.button.callback(...). */
function emittedCallbacks(): string[] {
  const found = new Set<string>();
  const re = /button\.callback\(\s*(?:'[^']*'|`[^`]*`|"[^"]*")\s*,\s*[`'"]([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(allSource)) !== null) found.add(m[1]);
  return [...found];
}

/** Callback data prefixes and literals the handlers match on. */
function handledCallbacks(): string[] {
  const found = new Set<string>();
  const re = /data(?:\s*===\s*|\.startsWith\(\s*)'([A-Za-z_][A-Za-z0-9_]*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(allSource)) !== null) found.add(m[1]);
  return [...found];
}

describe('callback data contract', () => {
  const emitted = emittedCallbacks();
  const handled = handledCallbacks();

  it('finds buttons and handlers to compare', () => {
    expect(emitted.length).toBeGreaterThan(50);
    expect(handled.length).toBeGreaterThan(50);
  });

  it('routes every emitted callback to a handler', () => {
    const orphans = emitted.filter(
      e => !handled.some(h => e.startsWith(h) || h.startsWith(e))
    );
    expect(orphans, `buttons with no handler: ${orphans.join(', ')}`).toEqual([]);
  });

  it('keeps the receipt approval buttons wired to their handlers', () => {
    // The exact regression: buttons said APPROVE_*, handlers matched CONFIRM_*.
    expect(allSource).toContain('CONFIRM_BUYER_RECEIPT_');
    expect(allSource).toContain('CONFIRM_SELLER_RECEIPT_');
    expect(emitted).toContain('CONFIRM_BUYER_RECEIPT_');
    expect(emitted).toContain('CONFIRM_SELLER_RECEIPT_');
    expect(handled).toContain('CONFIRM_BUYER_RECEIPT_');
    expect(handled).toContain('CONFIRM_SELLER_RECEIPT_');
  });
});

describe('admin callback authorization', () => {
  it('guards every admin-only prefix that a handler acts on', async () => {
    const { ADMIN_CALLBACK_PREFIXES, isAdminCallback, normalizeCallbackData } =
      await import('../src/bot/handlers/adminHandlers');

    for (const prefix of ADMIN_CALLBACK_PREFIXES) {
      expect(isAdminCallback(`${prefix}123`)).toBe(true);
    }

    // A user-facing callback must not be caught by the admin guard.
    expect(isAdminCallback('ACCEPT_DEAL_1')).toBe(false);
    expect(isAdminCallback('OFFER_ACCEPT_1')).toBe(false);

    // Buttons sent before the rename still arrive under the old names.
    expect(normalizeCallbackData('APPROVE_BUYER_RECEIPT_7')).toBe('CONFIRM_BUYER_RECEIPT_7');
    expect(normalizeCallbackData('APPROVE_SELLER_RECEIPT_7')).toBe('CONFIRM_SELLER_RECEIPT_7');
    expect(isAdminCallback(normalizeCallbackData('APPROVE_BUYER_RECEIPT_7'))).toBe(true);

    // Unrelated data passes through untouched.
    expect(normalizeCallbackData('ACCEPT_DEAL_3')).toBe('ACCEPT_DEAL_3');
  });
});
