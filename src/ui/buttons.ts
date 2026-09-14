import { Markup } from 'telegraf';
import { Icon } from './icons';

/**
 * Typed callback actions.
 *
 * Callback data used to be free-form strings matched by prefix, which is how a button
 * saying APPROVE_BUYER_RECEIPT_ and a handler matching CONFIRM_BUYER_RECEIPT_ could
 * ship together and silently strand every paid trade. Buttons and handlers now share
 * these builders and parsers, so the two sides cannot drift without failing to
 * compile.
 */

export const Action = {
  dealCardRefresh: 'DEAL_CARD_REFRESH',
  dealSendReceipt: 'DEAL_SEND_RECEIPT',
  dealDispute: 'DEAL_DISPUTE',
  adminConfirmBuyerReceipt: 'CONFIRM_BUYER_RECEIPT',
  adminRejectBuyerReceipt: 'REJECT_BUYER_RECEIPT',
  adminConfirmSellerReceipt: 'CONFIRM_SELLER_RECEIPT',
  adminRejectSellerReceipt: 'REJECT_SELLER_RECEIPT',
  adminApproveDeal: 'ADMIN_DEAL_APPROVE',
  adminRejectDeal: 'ADMIN_DEAL_REJECT'
} as const;

export type ActionName = (typeof Action)[keyof typeof Action];

/** Builds the callback data for an action against one record. */
export function data(action: ActionName, id: number | string): string {
  return `${action}_${id}`;
}

/**
 * Parses callback data, returning null when it is not this action.
 * Matching on the trailing separator stops ADMIN_DEAL_APPROVE from also swallowing
 * a hypothetical ADMIN_DEAL_APPROVE_ALL.
 */
export function parse(action: ActionName, raw: string): { id: string } | null {
  const prefix = `${action}_`;
  if (!raw.startsWith(prefix)) return null;
  const id = raw.slice(prefix.length);
  return id.length > 0 ? { id } : null;
}

/** Parses callback data whose id is numeric, returning null if it is not. */
export function parseId(action: ActionName, raw: string): number | null {
  const hit = parse(action, raw);
  if (!hit) return null;
  const n = parseInt(hit.id, 10);
  return Number.isFinite(n) ? n : null;
}

/** An inline button bound to an action and a record. */
export function button(label: string, action: ActionName, id: number | string) {
  return Markup.button.callback(label, data(action, id));
}

/** The pair of approve and reject buttons, laid out the same way everywhere. */
export function decisionRow(
  id: number | string,
  approve: { label: string; action: ActionName },
  reject: { label: string; action: ActionName }
) {
  return [button(approve.label, approve.action, id), button(reject.label, reject.action, id)];
}

/** A single cancel button, for wizards that need an escape on an inline keyboard. */
export const cancelButton = Markup.button.callback(`${Icon.cancel} انصراف`, 'CANCEL_WIZARD');
