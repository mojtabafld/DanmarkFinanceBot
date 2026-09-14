import { Markup } from 'telegraf';
import type { DealStatus } from '@prisma/client';
import { Icon } from './icons';
import { Action, button } from './buttons';
import { t, raw, type MessageKey } from '../i18n';
import { escapeHtml } from '../bot/utils/html';
import { formatToShamsi } from '../bot/utils/groupMessage';
import { DEAL_JOURNEY, DEAL_STATES, journeyIndex } from '../domain/dealMachine';

/**
 * The deal card: one message per side of a trade, edited in place as the state moves.
 *
 * It replaces a stream of one-off notifications that told a trader what had just
 * happened but never where their money was or what to do next. The card always
 * answers three questions: what the trade is, how far along it is, and whose turn it
 * is now. It carries exactly one button when the answer to the third is "yours", and
 * no button when it is not, because an action you cannot take yet is noise.
 */

export type Viewer = 'buyer' | 'seller';

export interface DealCardModel {
  dealId: number;
  code: string;
  /** Direction from the ad's point of view. */
  type: 'BUY' | 'SELL';
  currency: string;
  amount: number;
  unitPrice: number;
  status: DealStatus;
  deadlineAt: Date | null;
  counterpartyMention: string;
  /** Timezone the viewer's dates should be rendered in. */
  timeZone: string;
}

export interface RenderedCard {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
}

const fmt = (n: number) => n.toLocaleString('fa-IR');

/**
 * Renders the progress strip.
 *
 * Steps behind the current one are done, the current one is marked, and steps ahead
 * are dimmed. A rejected deal shows no strip at all: a half-filled progress bar on a
 * dead trade reads as though something is still coming.
 */
function timeline(status: DealStatus): string {
  if (status === 'REJECTED') return '';

  const here = journeyIndex(status);
  return DEAL_JOURNEY.map((step, i) => {
    const marker = i < here ? Icon.stepDone : i === here ? Icon.stepCurrent : Icon.stepTodo;
    const label = t(`step.${step}` as MessageKey);
    const emphasis = i === here ? `<b>${escapeHtml(label)}</b>` : escapeHtml(label);
    return `${marker} ${emphasis}`;
  }).join('\n');
}

/** The line telling the viewer whose turn it is, from their own point of view. */
function turnLine(model: DealCardModel, viewer: Viewer): string {
  const { status, deadlineAt, timeZone } = model;
  const spec = DEAL_STATES[status];
  const due = deadlineAt ? formatToShamsi(deadlineAt, timeZone) : '—';
  const overdue = deadlineAt !== null && deadlineAt.getTime() < Date.now();

  if (status === 'COMPLETED') return t('card.done');
  if (status === 'REJECTED') return t('card.rejected');
  if (overdue) return t('card.deadline.passed');

  if (spec.awaiting === 'admin') return t('card.await.admin', { deadline: due });

  const itIsYourTurn = spec.awaiting === viewer;
  if (itIsYourTurn) {
    return viewer === 'buyer'
      ? t('card.await.you.pay.buyer')
      : t('card.await.you.pay.seller');
  }

  return spec.awaiting === 'buyer'
    ? t('card.await.buyer', { deadline: due })
    : t('card.await.seller', { deadline: due });
}

/**
 * The one action this viewer can take right now, if any.
 *
 * Dispute only appears once the buyer's funds are committed, because before that
 * there is nothing to dispute and offering it invites confusion.
 */
function actions(model: DealCardModel, viewer: Viewer) {
  const spec = DEAL_STATES[model.status];
  const rows = [];

  if (!spec.terminal && spec.awaiting === viewer) {
    rows.push([button(t('btn.send.receipt'), Action.dealSendReceipt, model.dealId)]);
  }

  if (!spec.terminal && spec.fundsCommitted) {
    rows.push([
      button(t('btn.dispute'), Action.dealDispute, model.dealId),
      button(t('btn.refresh'), Action.dealCardRefresh, model.dealId)
    ]);
  } else if (!spec.terminal) {
    rows.push([button(t('btn.refresh'), Action.dealCardRefresh, model.dealId)]);
  }

  return Markup.inlineKeyboard(rows);
}

/** Builds the card for one side of a trade. */
export function renderDealCard(model: DealCardModel, viewer: Viewer): RenderedCard {
  const heading = model.type === 'BUY'
    ? t('card.title.buy', { currency: model.currency })
    : t('card.title.sell', { currency: model.currency });

  const total = model.amount * model.unitPrice;

  const lines = [
    `<b>${escapeHtml(heading)}</b>`,
    `<i>${escapeHtml(viewer === 'buyer' ? t('card.role.buyer') : t('card.role.seller'))}</i>`,
    '',
    `${t('card.code')}: <code>${escapeHtml(model.code)}</code>`,
    `${t('card.amount')}: <code>${fmt(model.amount)}</code> ${escapeHtml(model.currency)}`,
    `${t('card.rate')}: <code>${fmt(model.unitPrice)}</code> تومان`,
    `${t('card.total')}: <code>${fmt(total)}</code> تومان`,
    `${t('card.counterparty')}: ${model.counterpartyMention}`,
    '',
    `<b>${escapeHtml(t('card.progress'))}</b>`,
    timeline(model.status),
    '',
    turnLine(model, viewer)
  ];

  return {
    text: lines.filter(line => line !== null).join('\n').replace(/\n{3,}/g, '\n\n'),
    keyboard: actions(model, viewer)
  };
}

/** Which side of the trade a given user is on, given the ad's direction. */
export function viewerRole(adType: 'BUY' | 'SELL', isAdCreator: boolean): Viewer {
  // On a BUY ad the creator wants currency, so the creator is the buyer.
  if (adType === 'BUY') return isAdCreator ? 'buyer' : 'seller';
  return isAdCreator ? 'seller' : 'buyer';
}

/** Re-exported so callers can label an escalation without importing the catalogue. */
export function awaitingLabel(status: DealStatus): string {
  return t(`awaiting.${DEAL_STATES[status].awaiting}` as MessageKey);
}

export { raw };
