import { Telegraf } from 'telegraf';
import { BotContext } from '../index';
import { prisma } from '../../database/db';
import { Action, parseId } from '../../ui/buttons';
import { renderDealCard, viewerRole, type DealCardModel } from '../../ui/dealCard';
import { mentionUser } from '../utils/html';
import { getTimezoneByCountry } from '../utils/groupMessage';
import { notifyChatId } from '../../data/admins';
import { recordAudit } from '../../data/audit';
import { t } from '../../i18n';
import { UPLOAD_RECEIPT_SCENE_ID } from '../scenes/uploadReceipt';
import { DEAL_STATES } from '../../domain/dealMachine';

/**
 * The deal card: one message per side of a trade, refreshed in place.
 *
 * A trader previously had to reconstruct the state of their own trade from a stream
 * of notifications. The card is the single surface that answers where the money is
 * and whose turn it is.
 */

/** Loads a deal and builds the card model for one viewer, or null if not theirs. */
async function modelFor(dealId: number, telegramId: string): Promise<{ model: DealCardModel; viewer: 'buyer' | 'seller' } | null> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { proposal: { include: { creator: true } }, acceptor: true }
  });
  if (!deal) return null;

  const isCreator = deal.proposal.creator.telegramId === telegramId;
  const isAcceptor = deal.acceptor.telegramId === telegramId;
  if (!isCreator && !isAcceptor) return null;

  const me = isCreator ? deal.proposal.creator : deal.acceptor;
  const other = isCreator ? deal.acceptor : deal.proposal.creator;

  return {
    viewer: viewerRole(deal.proposal.type, isCreator),
    model: {
      dealId: deal.id,
      code: deal.proposal.code ?? String(deal.proposalId),
      type: deal.proposal.type,
      currency: deal.proposal.currency,
      amount: deal.amount,
      unitPrice: deal.proposal.price,
      status: deal.status,
      deadlineAt: deal.deadlineAt,
      counterpartyMention: mentionUser(other),
      timeZone: getTimezoneByCountry(me.country)
    }
  };
}

/** Sends a fresh card to one side and remembers its message id for later edits. */
export async function sendDealCard(
  telegram: Telegraf<BotContext>['telegram'],
  dealId: number,
  telegramId: string,
  side: 'creator' | 'acceptor'
): Promise<void> {
  const built = await modelFor(dealId, telegramId);
  if (!built) return;

  const card = renderDealCard(built.model, built.viewer);
  const sent = await telegram.sendMessage(telegramId, card.text, { ...card.keyboard });

  await prisma.deal.update({
    where: { id: dealId },
    data: side === 'creator' ? { creatorCardMsgId: sent.message_id } : { acceptorCardMsgId: sent.message_id }
  });
}

/**
 * Re-renders both sides' cards after a state change.
 * Failures are logged and swallowed: a card that could not be edited, because the
 * user blocked the bot or deleted the message, must not roll back the trade.
 */
export async function refreshDealCards(
  telegram: Telegraf<BotContext>['telegram'],
  dealId: number
): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { proposal: { include: { creator: true } }, acceptor: true }
  });
  if (!deal) return;

  const targets: Array<[string, number | null, 'creator' | 'acceptor']> = [
    [deal.proposal.creator.telegramId, deal.creatorCardMsgId, 'creator'],
    [deal.acceptor.telegramId, deal.acceptorCardMsgId, 'acceptor']
  ];

  for (const [telegramId, messageId, side] of targets) {
    const built = await modelFor(dealId, telegramId);
    if (!built) continue;
    const card = renderDealCard(built.model, built.viewer);

    // No card yet means this is the first state worth showing; send one.
    if (!messageId) {
      await telegram
        .sendMessage(telegramId, card.text, { ...card.keyboard })
        .then(sent =>
          prisma.deal.update({
            where: { id: dealId },
            data: side === 'creator' ? { creatorCardMsgId: sent.message_id } : { acceptorCardMsgId: sent.message_id }
          })
        )
        .catch(err => console.error(`Could not send deal card ${dealId} to ${telegramId}:`, err));
      continue;
    }

    await telegram
      .editMessageText(telegramId, messageId, undefined, card.text, { ...card.keyboard })
      .catch(err => {
        // "message is not modified" is the common, harmless case.
        const description = String(err?.description ?? err?.message ?? '');
        if (!description.includes('message is not modified')) {
          console.error(`Could not refresh deal card ${dealId} for ${telegramId}:`, description);
        }
      });
  }
}

export function registerDealCardHandlers(bot: Telegraf<BotContext>) {
  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return next();
    const data = ctx.callbackQuery.data;
    const from = ctx.from;
    if (!from) return next();

    const refreshId = parseId(Action.dealCardRefresh, data);
    if (refreshId !== null) {
      await ctx.answerCbQuery();
      await refreshDealCards(ctx.telegram, refreshId);
      return;
    }

    const receiptId = parseId(Action.dealSendReceipt, data);
    if (receiptId !== null) {
      const built = await modelFor(receiptId, from.id.toString());
      if (!built) {
        await ctx.answerCbQuery(t('err.not.your.deal'), { show_alert: true });
        return;
      }
      await ctx.answerCbQuery();
      await ctx.scene.enter(UPLOAD_RECEIPT_SCENE_ID, { dealId: receiptId });
      return;
    }

    const disputeId = parseId(Action.dealDispute, data);
    if (disputeId !== null) {
      const built = await modelFor(disputeId, from.id.toString());
      if (!built) {
        await ctx.answerCbQuery(t('err.not.your.deal'), { show_alert: true });
        return;
      }
      await ctx.answerCbQuery();

      await recordAudit(prisma, {
        actor: from.id.toString(),
        action: 'deal.dispute.open',
        subjectType: 'Deal',
        subjectId: disputeId,
        after: { status: built.model.status },
        note: `opened by the ${built.viewer}`
      });

      await ctx.telegram.sendMessage(
        notifyChatId(),
        `🆘 <b>اعتراض جدید روی معامله</b>\n\n` +
          `معامله <code>#${disputeId}</code> (آگهی <code>${built.model.code}</code>)\n` +
          `وضعیت: <code>${built.model.status}</code>\n` +
          `ثبت‌کننده اعتراض: ${mentionUser({ username: from.username, firstName: from.first_name, telegramId: String(from.id) })}\n` +
          (DEAL_STATES[built.model.status].fundsCommitted ? '💰 وجه خریدار پرداخت شده است.' : '')
      );

      await ctx.reply('🆘 اعتراض شما ثبت و به مدیریت ارسال شد. به‌زودی با شما تماس گرفته می‌شود.');
      return;
    }

    return next();
  });
}
