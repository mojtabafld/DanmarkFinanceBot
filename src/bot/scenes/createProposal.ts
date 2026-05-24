import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';

// Define the state interface
interface ProposalState {
  type?: 'BUY' | 'SELL';
  currency?: string;
  amount?: number;
  price?: number;
}

// Define the wizard context type
export interface MyWizardContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: ProposalState;
  };
}

export const CREATE_PROPOSAL_SCENE_ID = 'CREATE_PROPOSAL_SCENE';

export const createProposalWizard = new Scenes.WizardScene<MyWizardContext>(
  CREATE_PROPOSAL_SCENE_ID,
  // Step 1: Select Buy or Sell
  async (ctx) => {
    ctx.wizard.state = {};
    await ctx.reply(
      'لطفاً نوع پیشنهاد خود را انتخاب کنید:',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('🟢 خرید (Buy)', 'SELECT_BUY'),
          Markup.button.callback('🔴 فروش (Sell)', 'SELECT_SELL')
        ],
        [Markup.button.callback('❌ انصراف', 'CANCEL_WIZARD')]
      ])
    );
    return ctx.wizard.next();
  },

  // Step 2: Handle Buy/Sell selection & Ask for Currency
  async (ctx) => {
    // Check if it's a callback query
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === 'CANCEL_WIZARD') {
        await ctx.answerCbQuery();
        await ctx.reply('❌ ثبت پیشنهاد لغو شد.');
        return ctx.scene.leave();
      }

      if (data === 'SELECT_BUY') {
        ctx.wizard.state.type = 'BUY';
      } else if (data === 'SELECT_SELL') {
        ctx.wizard.state.type = 'SELL';
      } else {
        await ctx.reply('لطفاً یکی از گزینه‌های شیشه‌ای را انتخاب کنید.');
        return;
      }

      await ctx.answerCbQuery();
      await ctx.reply(
        'ارز مورد نظر خود را انتخاب کنید:',
        Markup.inlineKeyboard([
          [
            Markup.button.callback('🇩🇰 DKK (کرون دانمارک)', 'SELECT_CURR_DKK'),
            Markup.button.callback('🇪🇺 EUR (یورو)', 'SELECT_CURR_EUR'),
            Markup.button.callback('🇺🇸 USD (دلار آمریکا)', 'SELECT_CURR_USD')
          ],
          [Markup.button.callback('❌ انصراف', 'CANCEL_WIZARD')]
        ])
      );
      return ctx.wizard.next();
    }

    // If they typed something instead of clicking
    await ctx.reply('لطفاً یکی از دکمه‌های بالا را جهت تعیین نوع پیشنهاد انتخاب کنید.');
  },

  // Step 3: Handle Currency selection & Ask for Amount
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'CANCEL_WIZARD') {
        await ctx.reply('❌ ثبت پیشنهاد لغو شد.');
        return ctx.scene.leave();
      }

      let currency = '';
      if (data === 'SELECT_CURR_DKK') currency = 'DKK';
      else if (data === 'SELECT_CURR_EUR') currency = 'EUR';
      else if (data === 'SELECT_CURR_USD') currency = 'USD';
      else {
        await ctx.reply('لطفاً یکی از ارزهای بالا را انتخاب کنید.');
        return;
      }

      ctx.wizard.state.currency = currency;
      await ctx.reply(
        `لطفاً مقدار ارز (${currency}) مورد نظر خود را به صورت عدد انگلیسی وارد کنید:`,
        Markup.keyboard([['انصراف']]).oneTime().resize()
      );
      return ctx.wizard.next();
    }

    // If they typed something instead of clicking
    await ctx.reply('لطفاً یکی از گزینه‌های شیشه‌ای بالا را جهت تعیین ارز انتخاب کنید.');
  },

  // Step 4: Handle Amount & Ask for Price
  async (ctx) => {
    if ('text' in ctx.message!) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ ثبت پیشنهاد لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }

      // Parse and validate amount
      const amount = parseFloat(text.replace(/,/g, ''));
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('⚠️ مقدار وارد شده نامعتبر است. لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }

      ctx.wizard.state.amount = amount;
      await ctx.reply(
        `قیمت پیشنهادی هر واحد را به تومان وارد کنید (عدد انگلیسی):`,
        Markup.keyboard([['انصراف']]).oneTime().resize()
      );
      return ctx.wizard.next();
    }
    await ctx.reply('لطفاً مقدار ارز را به صورت عدد وارد کنید.');
  },

  // Step 5: Handle Price & Show Confirmation Summary
  async (ctx) => {
    if ('text' in ctx.message!) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ ثبت پیشنهاد لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }

      // Parse and validate price
      const price = parseFloat(text.replace(/,/g, ''));
      if (isNaN(price) || price <= 0) {
        await ctx.reply('⚠️ قیمت وارد شده نامعتبر است. لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }

      ctx.wizard.state.price = price;
      
      // Calculate totals
      const typeText = ctx.wizard.state.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';
      const currency = ctx.wizard.state.currency;
      const amount = ctx.wizard.state.amount!;
      const total = amount * price;

      const summaryText = 
        `📋 *پیش‌نویس پیشنهاد شما:*\n\n` +
        `🔹 *نوع تراکنش:* ${typeText}\n` +
        `🔹 *نام ارز:* ${currency}\n` +
        `🔹 *مقدار:* ${amount.toLocaleString('fa-IR')}\n` +
        `🔹 *قیمت واحد:* ${price.toLocaleString('fa-IR')} تومان\n` +
        `🔹 *مبلغ کل:* ${total.toLocaleString('fa-IR')} تومان\n\n` +
        `❓ آیا مایل به ارسال این پیشنهاد به گروه هستید؟`;

      await ctx.replyWithMarkdown(
        summaryText,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ تایید و ارسال به گروه', 'CONFIRM_PROPOSAL'),
            Markup.button.callback('❌ انصراف', 'CANCEL_WIZARD')
          ]
        ])
      );
      return ctx.wizard.next();
    }
    await ctx.reply('لطفاً قیمت پیشنهادی را به صورت عدد وارد کنید.');
  },

  // Step 6: Handle Confirmation and DB insert
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'CANCEL_WIZARD') {
        await ctx.reply('❌ ثبت پیشنهاد لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }

      if (data === 'CONFIRM_PROPOSAL') {
        const from = ctx.from;
        if (!from) {
          await ctx.reply('خطایی رخ داد. اطلاعات کاربری شما یافت نشد.');
          return ctx.scene.leave();
        }

        try {
          // 1. Get or create user in database
          let dbUser = await prisma.user.upsert({
            where: { telegramId: from.id.toString() },
            update: {
              username: from.username || null,
              firstName: from.first_name,
              lastName: from.last_name || null,
            },
            create: {
              telegramId: from.id.toString(),
              username: from.username || null,
              firstName: from.first_name,
              lastName: from.last_name || null,
            },
          });

          // 2. Create the proposal in database
          const proposal = await prisma.proposal.create({
            data: {
              creatorId: dbUser.id,
              type: ctx.wizard.state.type!,
              currency: ctx.wizard.state.currency!,
              amount: ctx.wizard.state.amount!,
              price: ctx.wizard.state.price!,
              priceCurrency: 'تومان',
              status: 'PENDING',
            },
          });

          // 3. Format message for the group
          const typeEmoji = proposal.type === 'BUY' ? '📥 #خرید' : '📤 #فروش';
          const typeText = proposal.type === 'BUY' ? 'خریدار ارز' : 'فروشنده ارز';
          const userMention = from.username 
            ? `@${from.username}` 
            : `[${from.first_name}](tg://user?id=${from.id})`;

          const groupMsgText =
            `📢 **پیشنهاد جدید معاملاتی**\n\n` +
            `${typeEmoji}\n` +
            `🔹 **ارز:** ${proposal.currency}\n` +
            `🔹 **مقدار:** ${proposal.amount.toLocaleString('fa-IR')}\n` +
            `🔹 **قیمت واحد:** ${proposal.price.toLocaleString('fa-IR')} تومان\n` +
            `🔹 **مبلغ کل:** ${(proposal.amount * proposal.price).toLocaleString('fa-IR')} تومان\n` +
            `👤 **توسط:** ${userMention}\n\n` +
            `ℹ️ برای ارسال پاسخ، قبول پیشنهاد یا گفتگو با ثبت‌کننده، روی دکمه زیر کلیک کنید:`;

          // Deep link to bot: https://t.me/BotUsername?start=deal_PROPOSAL_ID
          const deepLinkUrl = `https://t.me/${config.BOT_USERNAME}?start=deal_${proposal.id}`;

          // 4. Send to group
          const sentMessage = await ctx.telegram.sendMessage(
            config.GROUP_CHAT_ID,
            groupMsgText,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.url('🤝 قبول پیشنهاد / ارسال پاسخ', deepLinkUrl)]
              ])
            }
          );

          // 5. Update proposal with the group message ID
          await prisma.proposal.update({
            where: { id: proposal.id },
            data: { groupMessageId: sentMessage.message_id },
          });

          await ctx.reply(
            '✅ پیشنهاد شما با موفقیت ثبت و به گروه ارسال شد.',
            Markup.removeKeyboard()
          );

        } catch (error) {
          console.error('Error saving proposal:', error);
          await ctx.reply(
            '❌ متاسفانه در ثبت پیشنهاد خطایی رخ داد. لطفا مجددا تلاش کنید.',
            Markup.removeKeyboard()
          );
        }

        return ctx.scene.leave();
      }
    }

    await ctx.reply('لطفاً یکی از دکمه‌های بالا را جهت تایید نهایی انتخاب کنید.');
  }
);
