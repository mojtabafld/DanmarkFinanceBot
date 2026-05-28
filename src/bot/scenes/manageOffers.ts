import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { mainKeyboard } from '../utils/keyboards';
import { updateGroupProposalMessage } from '../utils/groupMessage';

export const MANAGE_OFFERS_SCENE_ID = 'MANAGE_OFFERS_SCENE';

export interface MyManageOffersContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: {
      offerId?: number;
      amount?: number;
      price?: number;
    };
  };
}

const manageOffersMenuKeyboard = Markup.keyboard([
  ['🔙 انصراف و بازگشت']
]).resize();

async function listOffers(ctx: MyManageOffersContext) {
  try {
    const dbUser = await prisma.user.findUnique({
      where: { telegramId: ctx.from!.id.toString() }
    });
    if (!dbUser) return ctx.scene.leave();

    const offers = await prisma.counterOffer.findMany({
      where: { proposerId: dbUser.id, status: 'PENDING' },
      include: { proposal: { include: { creator: true } } },
      orderBy: { createdAt: 'desc' }
    });

    if (offers.length === 0) {
      await ctx.reply('⚠️ شما در حال حاضر هیچ پیشنهاد قیمت معلقی روی آگهی‌های دیگران ثبت نکرده‌اید.', mainKeyboard);
      return ctx.scene.leave();
    }

    const buttons = offers.map(offer => {
      const typeText = offer.proposal.type === 'BUY' ? 'خرید' : 'فروش';
      return [Markup.button.callback(
        `کد ${offer.proposal.code} | مقدار: ${offer.amount} | نرخ: ${offer.price.toLocaleString('fa-IR')} ت`,
        `SELECT_OFFER_${offer.id}`
      )];
    });

    await ctx.reply(
      '🤝 **لیست پیشنهادهای قیمت شما روی آگهی‌های دیگران:**\n\n' +
      'یکی از پیشنهادهای زیر را جهت مدیریت (ویرایش/حذف) انتخاب کنید:',
      {
        ...manageOffersMenuKeyboard,
        ...Markup.inlineKeyboard(buttons)
      }
    );
    ctx.wizard.selectStep(1); // Set step cursor to Step 2
  } catch (err) {
    console.error('Error fetching counter offers:', err);
    await ctx.reply('❌ خطا در بارگذاری اطلاعات پیشنهادها.', mainKeyboard);
    return ctx.scene.leave();
  }
}

export const manageOffersWizard = new Scenes.WizardScene<MyManageOffersContext>(
  MANAGE_OFFERS_SCENE_ID,

  // Step 1: Fetch and List Counter Offers
  async (ctx) => {
    ctx.wizard.state = {};
    return listOffers(ctx);
  },

  // Step 2: Handle Selection / Options Callback
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '🔙 انصراف و بازگشت' || text === 'انصراف' || text === '/cancel') {
        await ctx.reply('🔙 به منوی اصلی بازگشتید.', mainKeyboard);
        return ctx.scene.leave();
      }
      await ctx.reply('لطفاً یکی از دکمه‌های شیشه‌ای را فشار دهید یا دکمه بازگشت را بزنید.');
      return;
    }

    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'BACK_TO_OFFERS_LIST') {
        ctx.wizard.selectStep(0);
        return listOffers(ctx);
      }

      if (data.startsWith('SELECT_OFFER_')) {
        const offerId = parseInt(data.replace('SELECT_OFFER_', ''), 10);
        if (isNaN(offerId)) return;

        try {
          const offer = await prisma.counterOffer.findUnique({
            where: { id: offerId },
            include: { proposal: { include: { creator: true } } }
          });

          if (!offer || offer.status !== 'PENDING') {
            await ctx.reply('⚠️ این پیشنهاد قیمت دیگر فعال نیست.');
            return;
          }

          const prop = offer.proposal;
          const typeText = prop.type === 'BUY' ? '🟢 خرید ارز توسط او' : '🔴 فروش ارز توسط او';
          const details = 
            `📋 **جزئیات پیشنهاد قیمت شما:**\n\n` +
            `🔹 **آگهی مربوطه:** کد ${prop.code ?? prop.id} (${typeText})\n` +
            `🔹 **مقدار کل آگهی:** ${prop.amount.toLocaleString('fa-IR')} ${prop.currency}\n` +
            `🔹 **نرخ واحد آگهی:** ${prop.price.toLocaleString('fa-IR')} تومان\n` +
            `🔹 **تسویه:** ${prop.paymentMethod || 'ثبت نشده'}\n` +
            `➖➖➖➖➖➖➖➖➖➖\n` +
            `💵 **مقدار پیشنهادی شما:** <code>${offer.amount.toLocaleString('fa-IR')}</code> ${prop.currency}\n` +
            `💵 **نرخ پیشنهادی شما:** <code>${offer.price.toLocaleString('fa-IR')}</code> تومان\n` +
            `💵 **ارزش کل پیشنهادی:** <code>${(offer.amount * offer.price).toLocaleString('fa-IR')}</code> تومان\n\n` +
            `👇 عملیات مورد نظر خود را انتخاب کنید:`;

          await ctx.replyWithHTML(
            details,
            Markup.inlineKeyboard([
              [
                Markup.button.callback('✏️ ویرایش پیشنهاد', `EDIT_OFFER_${offer.id}`),
                Markup.button.callback('❌ لغو پیشنهاد', `DELETE_OFFER_${offer.id}`)
              ],
              [Markup.button.callback('🔙 بازگشت به لیست پیشنهادها', 'BACK_TO_OFFERS_LIST')]
            ])
          );
        } catch (err) {
          console.error('Error showing offer details:', err);
        }
        return;
      }

      if (data.startsWith('DELETE_OFFER_')) {
        const offerId = parseInt(data.replace('DELETE_OFFER_', ''), 10);
        if (isNaN(offerId)) return;

        await ctx.reply(
          `⚠️ **لغو پیشنهاد**\nآیا از لغو و حذف کامل این پیشنهاد قیمت اطمینان دارید؟\nاین تغییر روی آگهی اصلی در گروه معاملاتی اعمال خواهد شد.`,
          Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ بله، لغو کن', `CONFIRM_DELETE_OFFER_${offerId}`),
              Markup.button.callback('❌ انصراف', `SELECT_OFFER_${offerId}`)
            ]
          ])
        );
        return;
      }

      if (data.startsWith('CONFIRM_DELETE_OFFER_')) {
        const offerId = parseInt(data.replace('CONFIRM_DELETE_OFFER_', ''), 10);
        if (isNaN(offerId)) return;

        try {
          const offer = await prisma.counterOffer.findUnique({
            where: { id: offerId },
            include: { proposal: { include: { creator: true } } }
          });

          if (!offer || offer.status !== 'PENDING') {
            await ctx.reply('⚠️ این پیشنهاد قیمت پیش از این غیرفعال یا لغو شده است.');
            return;
          }

          // Update CounterOffer status to REJECTED (means cancelled by proposer)
          await prisma.counterOffer.update({
            where: { id: offerId },
            data: { status: 'REJECTED' }
          });

          // Notify proposal creator privately
          const proposerMention = ctx.from!.username 
            ? `@${ctx.from!.username}` 
            : `<a href="tg://user?id=${ctx.from!.id}">${ctx.from!.first_name}</a>`;
            
          const cancelMsg = 
            `❌ **لغو پیشنهاد قیمت**\n\n` +
            `کاربر ${proposerMention} پیشنهاد خود را روی آگهی کد <code>${offer.proposal.code}</code> شما لغو کرد:\n` +
            `🔹 **مقدار پیشنهادی:** ${offer.amount.toLocaleString('fa-IR')} ${offer.proposal.currency}\n` +
            `🔹 **نرخ پیشنهادی:** ${offer.price.toLocaleString('fa-IR')} تومان`;

          await ctx.telegram.sendMessage(offer.proposal.creator.telegramId, cancelMsg, { parse_mode: 'HTML' })
            .catch(err => console.error('Failed to notify creator of offer cancellation:', err));

          // Update group message
          await updateGroupProposalMessage(ctx.telegram, offer.proposalId);

          await ctx.reply('✅ پیشنهاد قیمت شما با موفقیت لغو شد.');

          // Reset to list
          ctx.wizard.selectStep(0);
          return listOffers(ctx);
        } catch (err) {
          console.error('Error deleting offer:', err);
          await ctx.reply('❌ خطا در لغو پیشنهاد.');
        }
        return;
      }

      if (data.startsWith('EDIT_OFFER_')) {
        const offerId = parseInt(data.replace('EDIT_OFFER_', ''), 10);
        if (isNaN(offerId)) return;

        ctx.wizard.state.offerId = offerId;

        try {
          const offer = await prisma.counterOffer.findUnique({
            where: { id: offerId },
            include: { proposal: true }
          });
          if (!offer) return ctx.scene.leave();

          const maxAmount = offer.proposal.amount;
          await ctx.reply(
            `✏️ **ویرایش مقدار پیشنهادی (آگهی کد ${offer.proposal.code})**\n\n` +
            `مقدار پیشنهادی فعلی شما: <code>${offer.amount.toLocaleString('fa-IR')}</code> ${offer.proposal.currency}\n` +
            `حداکثر مقدار مجاز قابل معامله: <code>${maxAmount.toLocaleString('fa-IR')}</code>\n\n` +
            `لطفاً مقدار جدید پیشنهادی خود را وارد کنید (به صورت عدد انگلیسی):`,
            {
              parse_mode: 'HTML',
              ...manageOffersMenuKeyboard
            }
          );
          return ctx.wizard.next(); // Go to Step 3 (Amount input)
        } catch (err) {
          console.error('Error in EDIT_OFFER callback init:', err);
        }
        return;
      }
    }
  },

  // Step 3: Handle Amount Input & Ask for Price
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '🔙 انصراف و بازگشت' || text === 'انصراف' || text === '/cancel') {
        await ctx.reply('🔙 به منوی اصلی بازگشتید.', mainKeyboard);
        return ctx.scene.leave();
      }

      const amount = parseFloat(text.replace(/,/g, ''));
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('⚠️ مقدار وارد شده نامعتبر است. لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }

      try {
        const offer = await prisma.counterOffer.findUnique({
          where: { id: ctx.wizard.state.offerId! },
          include: { proposal: true }
        });
        if (!offer) return ctx.scene.leave();

        const maxAmount = offer.proposal.amount;
        if (amount > maxAmount) {
          await ctx.reply(`⚠️ مقدار وارد شده (${amount.toLocaleString('fa-IR')}) نمی‌تواند بیشتر از حداکثر مقدار مجاز (${maxAmount.toLocaleString('fa-IR')}) باشد. لطفا مجددا وارد کنید:`);
          return;
        }

        ctx.wizard.state.amount = amount;

        await ctx.reply(
          `✏️ **ویرایش نرخ پیشنهادی (آگهی کد ${offer.proposal.code})**\n\n` +
          `نرخ پیشنهادی فعلی شما: <code>${offer.price.toLocaleString('fa-IR')}</code> تومان\n` +
          `نرخ آگهی اصلی (حداکثر نرخ مجاز): <code>${offer.proposal.price.toLocaleString('fa-IR')}</code> تومان\n\n` +
          `لطفاً نرخ پیشنهادی جدید خود را به تومان وارد کنید:`,
          {
            parse_mode: 'HTML',
            ...manageOffersMenuKeyboard
          }
        );
        return ctx.wizard.next(); // Go to Step 4 (Price input)
      } catch (err) {
        console.error('Error handling amount in edit offer:', err);
      }
      return;
    }
    await ctx.reply('لطفاً مقدار را به صورت عدد وارد کنید.');
  },

  // Step 4: Handle Price Input & Show Confirmation Summary
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '🔙 انصراف و بازگشت' || text === 'انصراف' || text === '/cancel') {
        await ctx.reply('🔙 به منوی اصلی بازگشتید.', mainKeyboard);
        return ctx.scene.leave();
      }

      const price = parseFloat(text.replace(/,/g, ''));
      if (isNaN(price) || price <= 0) {
        await ctx.reply('⚠️ نرخ وارد شده نامعتبر است. لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }

      try {
        const offer = await prisma.counterOffer.findUnique({
          where: { id: ctx.wizard.state.offerId! },
          include: { proposal: true }
        });
        if (!offer) return ctx.scene.leave();

        if (price > offer.proposal.price) {
          await ctx.reply(`⚠️ نرخ پیشنهادی جدید شما (${price.toLocaleString('fa-IR')} تومان) نمی‌تواند بیشتر از نرخ آگهی اصلی (${offer.proposal.price.toLocaleString('fa-IR')} تومان) باشد. لطفا مجددا وارد کنید:`);
          return;
        }

        ctx.wizard.state.price = price;

        const amount = ctx.wizard.state.amount!;
        const total = amount * price;

        const summary = 
          `📝 **پیش‌نویس ویرایش پیشنهاد شما:**\n\n` +
          `🔹 **آگهی:** کد ${offer.proposal.code}\n` +
          `🔹 **مقدار جدید پیشنهادی:** ${amount.toLocaleString('fa-IR')} ${offer.proposal.currency}\n` +
          `🔹 **نرخ جدید پیشنهادی:** ${price.toLocaleString('fa-IR')} تومان\n` +
          `🔹 **مبلغ کل جدید پیشنهادی:** ${total.toLocaleString('fa-IR')} تومان\n\n` +
          `❓ آیا این ویرایش را تایید و اعمال می‌کنید؟`;

        await ctx.replyWithMarkdown(
          summary,
          Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ تایید و اعمال', 'CONFIRM_EDIT_OFFER'),
              Markup.button.callback('❌ انصراف', 'CANCEL_EDIT_OFFER')
            ]
          ])
        );
        return ctx.wizard.next(); // Go to Step 5
      } catch (err) {
        console.error('Error handling price in edit offer:', err);
      }
      return;
    }
    await ctx.reply('لطفاً نرخ را به صورت عدد وارد کنید.');
  },

  // Step 5: Handle Edit Offer Confirmation
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'CANCEL_EDIT_OFFER') {
        await ctx.reply('❌ ویرایش پیشنهاد لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      if (data === 'CONFIRM_EDIT_OFFER') {
        const offerId = ctx.wizard.state.offerId!;
        const amount = ctx.wizard.state.amount!;
        const price = ctx.wizard.state.price!;

        try {
          const offer = await prisma.counterOffer.findUnique({
            where: { id: offerId },
            include: { proposal: { include: { creator: true } } }
          });

          if (!offer || offer.status !== 'PENDING') {
            await ctx.reply('⚠️ پیشنهاد دیگر فعال نیست و تغییرات ذخیره نشد.', mainKeyboard);
            return ctx.scene.leave();
          }

          // Update CounterOffer in DB
          await prisma.counterOffer.update({
            where: { id: offerId },
            data: {
              amount: amount,
              price: price
            }
          });

          await ctx.reply('✅ پیشنهاد شما با موفقیت ویرایش شد و برای صاحب آگهی ارسال گردید.', mainKeyboard);

          // Notify proposal creator privately
          const proposerMention = ctx.from!.username 
            ? `@${ctx.from!.username}` 
            : `<a href="tg://user?id=${ctx.from!.id}">${ctx.from!.first_name}</a>`;

          const editMsg = 
            `🔔 **ویرایش پیشنهاد قیمت**\n\n` +
            `کاربر ${proposerMention} پیشنهاد خود را روی آگهی کد <code>${offer.proposal.code}</code> شما ویرایش کرد:\n` +
            `🔹 **مقدار پیشنهادی جدید:** <code>${amount.toLocaleString('fa-IR')}</code> ${offer.proposal.currency}\n` +
            `🔹 **نرخ پیشنهادی جدید:** <code>${price.toLocaleString('fa-IR')}</code> تومان\n` +
            `🔹 **ارزش کل جدید:** <code>${(amount * price).toLocaleString('fa-IR')}</code> تومان`;

          await ctx.telegram.sendMessage(offer.proposal.creator.telegramId, editMsg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ پذیرش پیشنهاد قیمت', `OFFER_ACCEPT_${offer.id}`),
                Markup.button.callback('❌ رد پیشنهاد قیمت', `OFFER_REJECT_${offer.id}`)
              ]
            ])
          }).catch(err => console.error('Failed to notify creator of offer edit:', err));

          // Update group message
          await updateGroupProposalMessage(ctx.telegram, offer.proposalId);

        } catch (err) {
          console.error('Error confirming edit offer:', err);
          await ctx.reply('❌ خطا در ذخیره‌سازی تغییرات.', mainKeyboard);
        }

        return ctx.scene.leave();
      }
    }

    await ctx.reply('لطفاً یکی از دکمه‌های شیشه‌ای را فشار دهید.');
  }
);
