import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { mainKeyboard } from '../utils/keyboards';
import { escapeHtml, mentionUser } from '../utils/html';
import { transitionDeal } from '../../data/deals';
import { refreshDealCards } from '../handlers/dealCardHandlers';

interface ReceiptState {
  dealId?: number;
  role?: 'BUYER' | 'SELLER';
  agreedPrice?: number;
  totalValue?: number;
  buyerPaymentInfo?: string;
  paymentMethod?: string;
}

export interface MyReceiptContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: ReceiptState;
  };
}

export const UPLOAD_RECEIPT_SCENE_ID = 'UPLOAD_RECEIPT_SCENE';

export const uploadReceiptWizard = new Scenes.WizardScene<MyReceiptContext>(
  UPLOAD_RECEIPT_SCENE_ID,

  // Step 1: Check active deals and ask for payment info (buyer) or jump to photo upload (seller)
  async (ctx) => {
    ctx.scene.state = {};
    ctx.wizard.state = ctx.scene.state;
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
        // Send a persistent cancel keyboard first to allow cancellation at any point
        await ctx.reply(
          `👤 <b>خریدار گرامی</b>\n\n` +
          `لطفاً مبلغ کل معامله به ارزش <code>${totalValue.toLocaleString('fa-IR')}</code> تومان را به حساب ادمین واریز نمایید:\n\n` +
          `💳 <b>شماره حساب بانک ملی:</b> <code>0000000012</code>\n` +
          `👤 <b>به نام:</b> فرشاد صادقی\n\n` +
          `📌 <b>جزئیات معامله:</b>\n` +
          `🔹 آگهی کد <code>${activeDeal.proposal.code ?? activeDeal.proposal.id}</code>\n` +
          `🔹 مقدار معامله: <code>${activeDeal.amount.toLocaleString('fa-IR')}</code> ${escapeHtml(activeDeal.proposal.currency)}\n` +
          `🔹 نرخ توافقی: <code>${agreedPrice.toLocaleString('fa-IR')}</code> تومان`,
          {
            parse_mode: 'HTML',
            ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
          }
        );

        await ctx.reply(
          `👇 <b>لطفاً ابتدا نوع حساب خود جهت دریافت کرون از فروشنده را انتخاب کنید:</b>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('💳 حساب رولوت (Revolut)', 'PAY_METHOD_REVOLUT'),
                Markup.button.callback('📱 موبایل‌پی (MobilePay)', 'PAY_METHOD_MOBILEPAY')
              ],
              [
                Markup.button.callback('🇩🇰 حساب بانکی دانمارک', 'PAY_METHOD_BANK')
              ]
            ])
          }
        );
        return ctx.wizard.next();
      } else {
        await ctx.reply(
          `👤 <b>فروشنده گرامی</b>\n\n` +
          `خریدار وجه ریالی را واریز و مدیریت آن را تایید کرده است.\n` +
          `لطفاً مقدار <code>${activeDeal.amount.toLocaleString('fa-IR')}</code> ${escapeHtml(activeDeal.proposal.currency)} را به حساب خریدار واریز کرده و تصویر فیش واریزی را ارسال کنید.\n\n` +
          `📋 <b>اطلاعات حساب خریدار جهت واریز کرون:</b>\n` +
          `<code>${escapeHtml(activeDeal.buyerPaymentInfo ?? 'ثبت نشده')}</code>\n\n` +
          `📌 <b>جزئیات معامله:</b>\n` +
          `🔹 آگهی کد <code>${activeDeal.proposal.code ?? activeDeal.proposal.id}</code>\n` +
          `🔹 نرخ توافقی: <code>${agreedPrice.toLocaleString('fa-IR')}</code> تومان\n` +
          `🔹 مبلغ کل معامله: <code>${totalValue.toLocaleString('fa-IR')}</code> تومان\n\n` +
          `👉 ارتباط با ادمین: @${config.ADMIN_USERNAME}`,
          {
            parse_mode: 'HTML',
            ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
          }
        );
        ctx.wizard.selectStep(2); // Skip Step 2 and go directly to photo upload (Step 3)
        return;
      }
    } catch (err) {
      console.error('Error starting uploadReceiptWizard:', err);
      await ctx.reply('❌ خطایی رخ داد.', mainKeyboard);
      return ctx.scene.leave();
    }
  },

  // Step 2: Handle Buyer Payment Info (Revolut, Denmark Bank Account or MobilePay)
  async (ctx) => {
    // Check for inline button callbacks
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery().catch(() => {});

      if (data === 'PAY_METHOD_REVOLUT') {
        ctx.wizard.state.paymentMethod = 'REVOLUT';
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(
          `💳 <b>روش انتخابی: حساب رولوت (Revolut)</b>\n\n` +
          `لطفاً اطلاعات حساب رولوت خود را طبق الگوی زیر ارسال کنید:\n` +
          `• <code>رولوت: @username</code>\n` +
          `• <code>رولوت: +4512345678</code>\n\n` +
          `✍️ اطلاعات را به صورت متنی تایپ و ارسال کنید:`,
          {
            parse_mode: 'HTML',
            ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
          }
        );
        return; // stay on Step 2 to wait for text input
      }

      if (data === 'PAY_METHOD_BANK') {
        ctx.wizard.state.paymentMethod = 'DENMARK_BANK';
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(
          `🇩🇰 <b>روش انتخابی: حساب بانکی دانمارک</b>\n\n` +
          `لطفاً اطلاعات حساب خود را شامل نام بانک، کد رجیستر (Reg) و شماره حساب طبق الگوی زیر ارسال کنید:\n` +
          `• <code>بانک: [نام بانک] - رجیستر: [کد Reg] - حساب: [شماره حساب]</code>\n\n` +
          `✍️ اطلاعات را به صورت متنی تایپ و ارسال کنید:`,
          {
            parse_mode: 'HTML',
            ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
          }
        );
        return; // stay on Step 2 to wait for text input
      }

      if (data === 'PAY_METHOD_MOBILEPAY') {
        ctx.wizard.state.paymentMethod = 'MOBILEPAY';
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(
          `📱 <b>روش انتخابی: موبایل‌پی (MobilePay)</b>\n\n` +
          `لطفاً شماره موبایل‌پی خود را (شماره تلفن ۸ رقمی دانمارک) طبق الگوی زیر ارسال کنید:\n` +
          `• <code>موبایل‌پی: 12345678</code>\n\n` +
          `✍️ اطلاعات را به صورت متنی تایپ و ارسال کنید:`,
          {
            parse_mode: 'HTML',
            ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
          }
        );
        return; // stay on Step 2 to wait for text input
      }
    }

    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات ارسال فیش لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      const method = ctx.wizard.state.paymentMethod;
      if (!method) {
        await ctx.reply(
          `⚠️ <b>لطفاً ابتدا یکی از روش‌های دریافت کرون را از دکمه‌های شیشه‌ای زیر انتخاب کنید:</b>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('💳 حساب رولوت (Revolut)', 'PAY_METHOD_REVOLUT'),
                Markup.button.callback('📱 موبایل‌پی (MobilePay)', 'PAY_METHOD_MOBILEPAY')
              ],
              [
                Markup.button.callback('🇩🇰 حساب بانکی دانمارک', 'PAY_METHOD_BANK')
              ]
            ])
          }
        );
        return;
      }

      const normalized = text.toLowerCase();
      let isValid = false;
      let errorMsg = '';

      if (method === 'REVOLUT') {
        const hasRevolut = normalized.includes('revolut') || normalized.includes('رولوت') || normalized.includes('@');
        isValid = hasRevolut && text.length >= 4;
        errorMsg = 
          `⚠️ <b>خطا در قالب اطلاعات رولوت!</b>\n\n` +
          `اطلاعات وارد شده باید معتبر بوده و شامل عبارت "رولوت" یا علامت "@" باشد.\n` +
          `الگو: <code>رولوت: @username</code>\n\n` +
          `✍️ لطفاً مجدداً اطلاعات صحیح را وارد کنید:`;
      } else if (method === 'DENMARK_BANK') {
        const hasBank = normalized.includes('bank') || normalized.includes('بانک') || normalized.includes('حساب') || normalized.includes('reg') || normalized.includes('رجیستر');
        const hasDigits = /\d{4,}/.test(normalized);
        isValid = hasBank && hasDigits && text.length >= 8;
        errorMsg = 
          `⚠️ <b>خطا در قالب اطلاعات حساب بانکی!</b>\n\n` +
          `اطلاعات وارد شده باید شامل نام بانک/کد رجیستر و شماره حساب باشد.\n` +
          `الگو: <code>بانک: Mellat - رجیستر: 1234 - حساب: 12345678</code>\n\n` +
          `✍️ لطفاً مجدداً اطلاعات صحیح را وارد کنید:`;
      } else if (method === 'MOBILEPAY') {
        const hasDigits = /\d{8,}/.test(normalized);
        isValid = hasDigits && text.length >= 8;
        errorMsg = 
          `⚠️ <b>خطا در قالب شماره موبایل‌پی!</b>\n\n` +
          `شماره موبایل‌پی باید حداقل شامل یک شماره ۸ رقمی باشد.\n` +
          `الگو: <code>موبایل‌پی: 12345678</code>\n\n` +
          `✍️ لطفاً مجدداً اطلاعات صحیح را وارد کنید:`;
      }

      if (!isValid) {
        await ctx.reply(errorMsg, {
          parse_mode: 'HTML',
          ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
        });
        return;
      }

      let methodLabel = '';
      if (method === 'REVOLUT') methodLabel = 'رولوت (Revolut)';
      else if (method === 'DENMARK_BANK') methodLabel = 'حساب بانکی دانمارک';
      else if (method === 'MOBILEPAY') methodLabel = 'موبایل‌پی (MobilePay)';

      const formattedInfo = `روش پرداخت: ${methodLabel}\nاطلاعات حساب: ${text}`;
      ctx.wizard.state.buyerPaymentInfo = formattedInfo;

      await ctx.reply(
        `✅ اطلاعات حساب شما ثبت شد:\n` +
        `<code>${formattedInfo}</code>\n\n` +
        `📸 <b>اکنون لطفاً تصویر فیش واریز ریالی خود را ارسال کنید:</b>`,
        {
          parse_mode: 'HTML',
          ...Markup.keyboard([['❌ انصراف']]).resize().oneTime()
        }
      );
      return ctx.wizard.next();
    }

    await ctx.reply('⚠️ لطفاً اطلاعات حساب خود را به صورت متنی ارسال کنید یا دکمه مورد نظر را کلیک کنید:');
  },

  // Step 3: Handle photo upload and send to admin
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
      const buyerPaymentInfo = ctx.wizard.state.buyerPaymentInfo;

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

        // The buyer's account details are part of what the admin checks the receipt
        // against, so they are stored before the state moves.
        if (role === 'BUYER' && buyerPaymentInfo) {
          await prisma.deal.update({ where: { id: dealId }, data: { buyerPaymentInfo } });
        }

        const moved = await transitionDeal(
          dealId,
          { type: role === 'BUYER' ? 'BUYER_UPLOAD_RECEIPT' : 'SELLER_UPLOAD_RECEIPT' },
          ctx.from!.id.toString()
        );

        if (!moved.ok) {
          await ctx.reply(
            '⚠️ وضعیت این معامله هم‌زمان تغییر کرد. لطفاً وضعیت فعلی را بررسی کنید.',
            mainKeyboard
          );
          return ctx.scene.leave();
        }

        await refreshDealCards(ctx.telegram, dealId);

        // Notify Admin
        if (role === 'BUYER') {
          const buyerMention = deal.proposal.type === 'BUY'
            ? (mentionUser(deal.proposal.creator))
            : (mentionUser(deal.acceptor));

          const adminMsgText =
            `🧾 <b>فیش واریز وجه ریالی (خریدار)</b>\n\n` +
            `👤 <b>خریدار:</b> ${buyerMention}\n` +
            `🔹 <b>مبلغ کل معامله:</b> <code>${totalValue.toLocaleString('fa-IR')}</code> تومان\n` +
            `🔹 <b>آگهی مربوطه:</b> کد ${deal.proposal.code ?? deal.proposalId}\n` +
            `🔹 <b>مقدار معامله:</b> <code>${deal.amount.toLocaleString('fa-IR')}</code> ${escapeHtml(deal.proposal.currency)}\n` +
            `📌 <b>اطلاعات حساب خریدار جهت واریز کرون:</b>\n` +
            `<code>${escapeHtml(buyerPaymentInfo)}</code>\n\n` +
            `❓ آیا فیش واریزی خریدار مورد تایید است؟`;

          await ctx.telegram.sendPhoto(config.ADMIN_CHAT_ID, fileId, {
            caption: adminMsgText,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ تایید فیش خریدار', `CONFIRM_BUYER_RECEIPT_${deal.id}`),
                Markup.button.callback('❌ رد فیش خریدار', `REJECT_BUYER_RECEIPT_${deal.id}`)
              ]
            ])
          });
        } else {
          const sellerMention = deal.proposal.type === 'SELL'
            ? (mentionUser(deal.proposal.creator))
            : (mentionUser(deal.acceptor));

          const adminMsgText =
            `🧾 <b>فیش انتقال کرون (فروشنده)</b>\n\n` +
            `👤 <b>فروشنده:</b> ${sellerMention}\n` +
            `🔹 <b>مقدار انتقال:</b> <code>${deal.amount.toLocaleString('fa-IR')}</code> ${escapeHtml(deal.proposal.currency)}\n` +
            `🔹 <b>آگهی مربوطه:</b> کد ${deal.proposal.code ?? deal.proposalId}\n` +
            `🔹 <b>مبلغ کل معامله:</b> <code>${totalValue.toLocaleString('fa-IR')}</code> تومان\n` +
            `📌 <b>اطلاعات حساب خریدار جهت تطبیق:</b>\n` +
            `<code>${escapeHtml(deal.buyerPaymentInfo ?? 'ثبت نشده')}</code>\n\n` +
            `❓ آیا فیش انتقال فروشنده مورد تایید است؟`;

          await ctx.telegram.sendPhoto(config.ADMIN_CHAT_ID, fileId, {
            caption: adminMsgText,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ تایید فیش فروشنده', `CONFIRM_SELLER_RECEIPT_${deal.id}`),
                Markup.button.callback('❌ رد فیش فروشنده', `REJECT_SELLER_RECEIPT_${deal.id}`)
              ]
            ])
          });
        }

        await ctx.reply('✅ فیش واریزی شما با موفقیت برای مدیریت ارسال شد و در انتظار تایید است.', mainKeyboard);
        return ctx.scene.leave();
      } catch (err) {
        console.error('Error handling uploaded receipt photo:', err);
        // The underlying error goes to the logs above, not to the user: internal
        // failure text is not actionable for them and can leak implementation detail.
        await ctx.reply(
          '❌ خطا در فرآیند ارسال فیش به مدیریت. لطفاً دوباره تلاش کنید و در صورت تکرار با پشتیبانی تماس بگیرید.',
          mainKeyboard
        );
        return ctx.scene.leave();
      }
    }

    await ctx.reply('⚠️ لطفاً فیش واریزی خود را به صورت تصویر (Photo) ارسال کنید:');
  }
);
