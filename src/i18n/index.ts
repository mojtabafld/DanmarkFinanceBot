import { escapeHtml } from '../bot/utils/html';
import { fa } from './fa';

/**
 * Message catalogue.
 *
 * Copy used to be 1,245 string literals scattered through the handlers, so a wording
 * change meant editing business logic and a second language was not reachable at all.
 *
 * Interpolated values are HTML-escaped by default, which makes the safe thing the
 * default thing: a user's name or bank details cannot break out of the markup and
 * make Telegram reject the whole message. Pre-built markup opts out through `raw`.
 */

export type Locale = 'fa';
export type MessageKey = keyof typeof fa;

const CATALOGUES: Record<Locale, Record<string, string>> = { fa };

export const DEFAULT_LOCALE: Locale = 'fa';

/** Marks a value as already-safe HTML, exempting it from escaping. */
const RAW = Symbol('raw-html');
export interface RawHtml { [RAW]: true; value: string }
export function raw(value: string): RawHtml {
  return { [RAW]: true, value };
}
function isRaw(v: unknown): v is RawHtml {
  return typeof v === 'object' && v !== null && RAW in v;
}

export type Param = string | number | RawHtml | null | undefined;

/**
 * Looks up a message and fills its `{placeholders}`.
 *
 * A missing key returns the key itself rather than throwing: a copy mistake should
 * show up as odd-looking text, not take down the handler mid-trade.
 */
export function t(key: MessageKey, params: Record<string, Param> = {}, locale: Locale = DEFAULT_LOCALE): string {
  const template = CATALOGUES[locale]?.[key] ?? CATALOGUES[DEFAULT_LOCALE][key];
  if (template === undefined) {
    console.error(`Missing message key: ${key}`);
    return key;
  }

  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in params)) return whole;
    const value = params[name];
    if (value === null || value === undefined) return '';
    if (isRaw(value)) return value.value;
    return escapeHtml(value);
  });
}

/** Every key in the catalogue, for the completeness test. */
export function messageKeys(locale: Locale = DEFAULT_LOCALE): string[] {
  return Object.keys(CATALOGUES[locale]);
}
