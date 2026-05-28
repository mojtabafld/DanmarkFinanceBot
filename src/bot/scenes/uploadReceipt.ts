import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { mainKeyboard } from '../utils/keyboards';

interface ReceiptState {
  dealId?: number;
  role?: 'BUYER' | 'SELLER';
  agreedPrice?: number;
  totalValue?: number;
}

export interface MyReceiptContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: ReceiptState;
  };
}

export const UPLOAD_RECEIPT_SCENE_ID = 'UPLOAD_RECEIPT_SCENE';

export const uploadReceiptWizard = new Scenes.WizardScene<MyReceiptContext>(
  UPLOAD_RECEIPT_SCENE_ID,

  // Step 1: Check active deals and ask for photo
  async (ctx) => {
    ctx.wizard.state = {};
    const from = ctx.from;
    if (!from) return ctx.scene.leave();

    try {
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() }
      });
      if (!dbUser) {
        await ctx.reply('❌ اطلاعات کاربری شما یافت نشد.', mainKeyboard);
        return ctx.scene.leave();
      }

      const activeDeal = await prisma.deal.findFirst({
        where: {
          OR: [
            {
              status: 'WAITING_BUYER_PAYMENT',
              OR: [
                { acceptorId: dbUser.id, proposal: { type: 'SELL' } },
                { proposal: { creatorId: dbUser.id, type: 'BUY' } }
              ]
            },
            {
              status: 'WAITING_SELLER_PAYMENT',
              OR: [
                { acceptorId: dbUser.id, proposal: { type: 'BUY' } },
                { proposal: { creatorId: dbUser.id, type: 'SELL' } }
              ]
            }
          ]
        },
        include: {
          proposal: { include: { creator: true } },
          acceptor: true
        }
      });

      if (!activeDeal) {
        await ctx.reply('⚠️ شما در حال حاضر هیچ معامله فعلی در انتظار واریز فیش ندارید.', mainKeyboard);
        return ctx.scene.leave();
      }

      const isProposalBuy = activeDeal.proposal.type === 'BUY';
      const isCreator = activeDeal.proposal.creatorId === dbUser.id;
      const isBuyer = (isProposalBuy && isCreator) || (!isProposalBuy && !isCreator);

      const role = isBuyer ? 'BUYER' : 'SELLER';

      // Find agreed price
      const acceptedOffer = await prisma.counterOffer.findFirst({
        where: {
          proposalId: activeDeal.proposalId,
          proposerId: activeDeal.acceptorId,
          status: 'ACCEPTED'
        }
      });
      const agreedPrice = acceptedOffer ? acceptedOffer.price : activeDeal.proposal.price;
      const totalValue = activeDeal.amount * agreedPrice;

      ctx.wizard.state.dealId = activeDeal.id;
      ctx.wizard.state.role = role;
      ctx.wizard.state.agreedPrice = agreedPrice;
      ctx.wizard.state.totalValue = totalValue;

      if (role === 'BUYER') {
        await ctx.reply(
          `👤 **خریدار گرامی**\n\n` +
          `لطفاً مبلغ کل معامله به ارزش <code>${totalValue.toLocaleString('fa-IR')}</code> تومان را به حساب ادمین واریز کرده و سپس تصویر فیش واریزی را ارسال کنید.\n\n` +
          `📌 **جزئیات معامله:**\n` +
          `🔹 آگهی کد <code>${activeDeal.proposal.code ?? activeDeal.proposal.id}</code>\n` +
          `🔹 مقدار معامله: <code>${activeDeal.amount.toLocaleString('fa-IR')}</code> ${activeDeal.proposal.currency}\n` +
          `🔹 نرخ توافقی: <code>${agreedPrice.toLocaleString('fa-IR')}</code> تومان\n\n` +
          `👉 ارتباط با ادمین جهت دریافت شماره حساب: @${config.ADMIN_USERNAME}`,
          {
            parse_mode: 'HTML',
            ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
          }
        );
      } else {
        await ctx.reply(
          `👤 **فروشنده گرامی**\n\n` +
          `خریدار وجه ریالی را واریز و مدیریت آن را تایید کرده است.\n` +
          `لطفاً مقدار <code>${activeDeal.amount.toLocaleString('fa-IR')}</code> ${activeDeal.proposal.currency} را به حساب خریدار واریز کرده و تصویر فیش واریزی را ارسال کنید.\n\n` +
          `📌 **جزئیات معامله:**\n` +
          `🔹 آگهی کد <code>${activeDeal.proposal.code ?? activeDeal.proposal.id}</code>\n` +
          `🔹 نرخ توافقی: <code>${agreedPrice.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 مبلغ کل معامله: <code>${totalValue.toLocaleString('fa-IR')}</code> تومان\n\n` +
          `👉 ارتباط با ادمین: @${config.ADMIN_USERNAME}`,
          {
            parse_mode: 'HTML',
            ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
          }
        );
      }
      return ctx.wizard.next();
    } catch (err) {
      console.error('Error starting uploadReceiptWizard:', err);
      await ctx.reply('❌ خطایی رخ داد.', mainKeyboard);
      return ctx.scene.leave();
    }
  },

  // Step 2: Handle photo upload and send to admin
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات ارسال فیش لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }
    }

    if (ctx.message && 'photo' in ctx.message) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const fileId = photo.file_id;

      const dealId = ctx.wizard.state.dealId!;
      const role = ctx.wizard.state.role!;
      const totalValue = ctx.wizard.state.totalValue!;

      try {
        const deal = await prisma.deal.findUnique({
          where: { id: dealId },
          include: {
            proposal: { include: { creator: true } },
            acceptor: true
          }
        });

        if (!deal) {
          await ctx.reply('❌ معامله مربوطه یافت نشد.', mainKeyboard);
          return ctx.scene.leave();
        }

        if (role === 'BUYER' && deal.status !== 'WAITING_BUYER_PAYMENT') {
          await ctx.reply('⚠️ این معامله در مرحله پرداخت خریدار نیست یا قبلاً پرداخت شده است.', mainKeyboard);
          return ctx.scene.leave();
        }

        if (role === 'SELLER' && deal.status !== 'WAITING_SELLER_PAYMENT') {
          await ctx.reply('⚠️ این معامله در مرحله پرداخت فروشنده نیست یا قبلاً پرداخت شده است.', mainKeyboard);
          return ctx.scene.leave();
        }

        // Update status in DB
        const newStatus = role === 'BUYER' ? 'BUYER_PAID_PENDING_APPROVAL' : 'SELLER_PAID_PENDING_APPROVAL';
        await prisma.deal.update({
          where: { id: dealId },
          data: { status: newStatus }
        });

        // Notify Admin
        if (role === 'BUYER') {
          const buyerMention = deal.proposal.type === 'BUY'
            ? (deal.proposal.creator.username ? `@${deal.proposal.creator.username}` : `<a href="tg://user?id=${deal.proposal.creator.telegramId}">${deal.proposal.creator.firstName}</a>`)
            : (deal.acceptor.username ? `@${deal.acceptor.username}` : `<a href="tg://user?id=${deal.acceptor.telegramId}">${deal.acceptor.firstName}</a>`);

          const adminMsgText =
            `🧾 <b>فیش واریز وجه ریالی (خریدار)</b>\n\n` +
            `👤 <b>خریدار:</b> ${buyerMention}\n` +
            `🔹 <b>مبلغ کل معامله:</b> <code>${totalValue.toLocaleString('fa-IR')}</code> تومان\n` +
            `🔹 <b>آگهی مربوطه:</b> کد ${deal.proposal.code ?? deal.proposalId}\n` +
            `🔹 <b>مقدار معامله:</b> <code>${deal.amount.toLocaleString('fa-IR')}</code> ${deal.proposal.currency}\n\n` +
            `❓ آیا فیش واریزی خریدار مورد تایید است؟`;

          await ctx.telegram.sendPhoto(config.ADMIN_CHAT_ID, fileId, {
            caption: adminMsgText,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ تایید فیش خریدار', `APPROVE_BUYER_RECEIPT_${deal.id}`),
                Markup.button.callback('❌ رد فیش خریدار', `REJECT_BUYER_RECEIPT_${deal.id}`)
              ]
            ])
          });
        } else {
          const sellerMention = deal.proposal.type === 'SELL'
            ? (deal.proposal.creator.username ? `@${deal.proposal.creator.username}` : `<a href="tg://user?id=${deal.proposal.creator.telegramId}">${deal.proposal.creator.firstName}</a>`)
            : (deal.acceptor.username ? `@${deal.acceptor.username}` : `<a href="tg://user?id=${deal.acceptor.telegramId}">${deal.acceptor.firstName}</a>`);

          const adminMsgText =
            `🧾 <b>فیش انتقال کرون (فروشنده)</b>\n\n` +
            `👤 <b>فروشنده:</b> ${sellerMention}\n` +
            `🔹 <b>مقدار انتقال:</b> <code>${deal.amount.toLocaleString('fa-IR')}</code> ${deal.proposal.currency}\n` +
            `🔹 <b>آگهی مربوطه:</b> کد ${deal.proposal.code ?? deal.proposalId}\n` +
            `🔹 <b>مبلغ کل معامله:</b> <code>${totalValue.toLocaleString('fa-IR')}</code> تومان\n\n` +
            `❓ آیا فیش انتقال فروشنده مورد تایید است؟`;

          await ctx.telegram.sendPhoto(config.ADMIN_CHAT_ID, fileId, {
            caption: adminMsgText,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ تایید فیش فروشنده', `APPROVE_SELLER_RECEIPT_${deal.id}`),
                Markup.button.callback('❌ رد فیش فروشنده', `REJECT_SELLER_RECEIPT_${deal.id}`)
              ]
            ])
          });
        }

        await ctx.reply('✅ فیش واریزی شما با موفقیت برای مدیریت ارسال شد و در انتظار تایید است.', mainKeyboard);
        return ctx.scene.leave();
      } catch (err) {
        console.error('Error handling uploaded receipt photo:', err);
        await ctx.reply('❌ خطا در فرآیند ارسال فیش به مدیریت.', mainKeyboard);
        return ctx.scene.leave();
      }
    }

    await ctx.reply('⚠️ لطفاً فیش واریزی خود را به صورت تصویر (Photo) ارسال کنید:');
  }
);
