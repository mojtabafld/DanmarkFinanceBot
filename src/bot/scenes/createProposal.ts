import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { mainKeyboard } from '../utils/keyboards';
import { updateGroupProposalMessage, formatToShamsi } from '../utils/groupMessage';

// Define the state interface
interface ProposalState {
  type?: 'BUY' | 'SELL';
  currency?: string;
  paymentMethod?: string;
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

async function getNextAvailableCode(): Promise<string> {
  try {
    const activeProposals = await prisma.proposal.findMany({
      where: {
        status: { in: ['PENDING', 'LOCKED'] }
      },
      select: { code: true }
    });
    
    const usedCodes = new Set(activeProposals.map(p => p.code).filter(Boolean));
    
    for (let i = 1; i <= 9999; i++) {
      const codeStr = i.toString().padStart(4, '0');
      if (!usedCodes.has(codeStr)) {
        return codeStr;
      }
    }
  } catch (err) {
    console.error('Error allocating code:', err);
  }
  return '0001';
}

export const createProposalWizard = new Scenes.WizardScene<MyWizardContext>(
  CREATE_PROPOSAL_SCENE_ID,
  // Step 1: Select Buy or Sell
  async (ctx) => {
    ctx.wizard.state = {};
    const from = ctx.from;
    if (!from) {
      await ctx.reply('خطایی رخ داد. اطلاعات کاربری شما یافت نشد.');
      return ctx.scene.leave();
    }

    try {
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() }
      });

      if (dbUser) {
        const activeCount = await prisma.proposal.count({
          where: {
            creatorId: dbUser.id,
            createdAt: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
            },
            status: {
              not: 'CANCELLED'
            }
          }
        });

        const limit = dbUser.dailyProposalLimit;
        if (activeCount >= limit) {
          await ctx.reply(
            `⚠️ **محدودیت تعداد پیشنهاد روزانه**\n\n` +
            `کاربر گرامی، شما در ۲۴ ساعت گذشته تعداد <code>${activeCount}</code> پیشنهاد ثبت کرده‌اید و به حد مجاز روزانه خود (<code>${limit}</code> پیشنهاد) رسیده‌اید.\n\n` +
            `امکان ثبت پیشنهاد جدید تا پایان بازه ۲۴ ساعته مقدور نیست.`,
            { parse_mode: 'HTML' }
          );
          return ctx.scene.leave();
        }
      }
    } catch (err) {
      console.error('Error checking daily proposal limit:', err);
    }

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

    await ctx.reply('لطفاً یکی از دکمه‌های بالا را جهت تعیین نوع پیشنهاد انتخاب کنید.');
  },

  // Step 3: Handle Currency selection & Ask for Payment Method
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

      // Ask for payment method based on ad type
      const isSell = ctx.wizard.state.type === 'SELL';
      const promptText = isSell 
        ? 'روش دریافت مبلغ (تسویه) را انتخاب کنید:'
        : 'روش پرداخت مبلغ (تسویه) را انتخاب کنید:';
        
      const cashText = isSell ? '💵 فروش نقدی (اسکناس)' : '💵 خرید نقدی (اسکناس)';
      const revolutText = isSell ? '💳 فروش از طریق رولوت' : '💳 خرید از طریق رولوت';
      const bankText = '🏦 واریز به حساب';

      await ctx.reply(
        promptText,
        Markup.inlineKeyboard([
          [Markup.button.callback(cashText, 'SELECT_PAY_CASH')],
          [Markup.button.callback(revolutText, 'SELECT_PAY_REVOLUT')],
          [Markup.button.callback(bankText, 'SELECT_PAY_BANK')],
          [Markup.button.callback('❌ انصراف', 'CANCEL_WIZARD')]
        ])
      );
      return ctx.wizard.next();
    }

    await ctx.reply('لطفاً یکی از گزینه‌های شیشه‌ای بالا را جهت تعیین ارز انتخاب کنید.');
  },

  // Step 4: Handle Payment Method & Ask for Amount
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'CANCEL_WIZARD') {
        await ctx.reply('❌ ثبت پیشنهاد لغو شد.');
        return ctx.scene.leave();
      }

      let paymentMethod = '';
      const isSell = ctx.wizard.state.type === 'SELL';

      if (data === 'SELECT_PAY_CASH') {
        paymentMethod = isSell ? 'فروش نقدی (اسکناس)' : 'خرید نقدی (اسکناس)';
      } else if (data === 'SELECT_PAY_REVOLUT') {
        paymentMethod = isSell ? 'فروش از طریق رولوت' : 'خرید از طریق رولوت';
      } else if (data === 'SELECT_PAY_BANK') {
        paymentMethod = 'واریز به حساب';
      } else {
        await ctx.reply('لطفاً یکی از گزینه‌های تسویه را انتخاب کنید.');
        return;
      }

      ctx.wizard.state.paymentMethod = paymentMethod;
      const currency = ctx.wizard.state.currency;

      await ctx.reply(
        `لطفاً مقدار ارز (${currency}) مورد نظر خود را به صورت عدد انگلیسی وارد کنید:`,
        Markup.keyboard([['انصراف']]).oneTime().resize()
      );
      return ctx.wizard.next();
    }

    await ctx.reply('لطفاً یکی از گزینه‌های تسویه بالا را انتخاب کنید.');
  },

  // Step 5: Handle Amount & Ask for Price
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ ثبت پیشنهاد لغو شد.', mainKeyboard);
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

  // Step 6: Handle Price & Show Confirmation Summary
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ ثبت پیشنهاد لغو شد.', mainKeyboard);
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
      const paymentMethod = ctx.wizard.state.paymentMethod;
      const amount = ctx.wizard.state.amount!;
      const total = amount * price;

      const summaryText = 
        `📋 *پیش‌نویس پیشنهاد شما:*\n\n` +
        `🔹 *نوع تراکنش:* ${typeText}\n` +
        `🔹 *نام ارز:* ${currency}\n` +
        `🔹 *نوع تسویه:* ${paymentMethod}\n` +
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

  // Step 7: Handle Confirmation and DB insert
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'CANCEL_WIZARD') {
        await ctx.reply('❌ ثبت پیشنهاد لغو شد.', mainKeyboard);
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

          // Allocate code
          const code = await getNextAvailableCode();

          // 2. Create the proposal in database
          const proposal = await prisma.proposal.create({
            data: {
              creatorId: dbUser.id,
              type: ctx.wizard.state.type!,
              currency: ctx.wizard.state.currency!,
              amount: ctx.wizard.state.amount!,
              originalAmount: ctx.wizard.state.amount!,
              paymentMethod: ctx.wizard.state.paymentMethod!,
              price: ctx.wizard.state.price!,
              priceCurrency: 'تومان',
              status: 'PENDING',
              code: code
            },
          });

          // 3. Format message for the group
          const typeHeader = proposal.type === 'BUY' ? '🟢 #خرید_ارز' : '🔴 #فروش_ارز';
          const userMention = from.username 
            ? `@${from.username}` 
            : `<a href="tg://user?id=${from.id}">${from.first_name}</a>`;

          const groupMsgText =
            `📢 <b>پیشنهاد جدید معاملاتی</b>\n\n` +
            `<b>${typeHeader}</b>\n\n` +
            `🔹 <b>کد حواله:</b> <code>${proposal.code}</code>\n` +
            `🔹 <b>ارز:</b> <code>${proposal.currency}</code>\n` +
            `🔹 <b>نوع تسویه:</b> <code>${proposal.paymentMethod}</code>\n` +
            `🔹 <b>مقدار کل:</b> <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
            `🔹 <b>مقدار باقیمانده:</b> <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
            `🔹 <b>قیمت واحد:</b> <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n` +
            `🔹 <b>مبلغ کل:</b> <code>${(proposal.amount * proposal.price).toLocaleString('fa-IR')}</code> تومان\n` +
            `👤 <b>توسط:</b> ${userMention}\n` +
            `📅 <b>تاریخ ثبت:</b> <code>${formatToShamsi(proposal.createdAt)}</code>\n\n` +
            `ℹ️ برای ارسال پاسخ، قبول پیشنهاد یا گفتگو با ثبت‌کننده، روی دکمه زیر کلیک کنید:`;

          const deepLinkUrl = `https://t.me/${config.BOT_USERNAME}?start=deal_${proposal.id}`;

          // 4. Send to group
          const sentMessage = await ctx.telegram.sendMessage(
            config.GROUP_CHAT_ID,
            groupMsgText,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [Markup.button.url('🤝 قبول پیشنهاد / ارسال پاسخ', deepLinkUrl)]
              ])
            }
          );

          // Send copy with admin control keyboard privately to Admin
          const adminMsgText =
            `🔔 <b>پیشنهاد جدید معاملاتی ثبت شد:</b>\n\n` +
            `<b>${typeHeader}</b>\n\n` +
            `🔹 <b>کد حواله:</b> <code>${proposal.code}</code>\n` +
            `🔹 <b>ارز:</b> <code>${proposal.currency}</code>\n` +
            `🔹 <b>نوع تسویه:</b> <code>${proposal.paymentMethod}</code>\n` +
            `🔹 <b>مقدار:</b> <code>${proposal.amount.toLocaleString('fa-IR')}</code>\n` +
            `🔹 <b>قیمت واحد:</b> <code>${proposal.price.toLocaleString('fa-IR')}</code> تومان\n` +
            `🔹 <b>مبلغ کل:</b> <code>${(proposal.amount * proposal.price).toLocaleString('fa-IR')}</code> تومان\n` +
            `👤 <b>توسط:</b> ${userMention}\n` +
            `📅 <b>تاریخ ثبت:</b> <code>${formatToShamsi(proposal.createdAt)}</code>\n\n` +
            `⚙️ <b>دکمه‌های مدیریت پیشنهاد:</b>`;

          await ctx.telegram.sendMessage(
            config.ADMIN_CHAT_ID,
            adminMsgText,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback('❌ لغو پیشنهاد', `ADMIN_PROP_CANCEL_${proposal.id}`),
                  Markup.button.callback('🗑 حذف پیشنهاد', `ADMIN_PROP_DELETE_${proposal.id}`)
                ],
                [
                  Markup.button.callback('✏️ مقدار', `ADMIN_PROP_EDIT_amount_${proposal.id}`),
                  Markup.button.callback('✏️ قیمت', `ADMIN_PROP_EDIT_price_${proposal.id}`)
                ],
                [
                  Markup.button.callback('👤 پرونده کاربر ثبت‌کننده', `ADMIN_USER_VIEW_${dbUser.id}`)
                ]
              ])
            }
          ).catch(err => console.error('Failed to notify admin about new proposal:', err));

          // 5. Update proposal with the group message ID
          await prisma.proposal.update({
            where: { id: proposal.id },
            data: { groupMessageId: sentMessage.message_id },
          });

          await ctx.reply(
            '✅ پیشنهاد شما با موفقیت ثبت و به گروه ارسال شد.',
            mainKeyboard
          );

        } catch (error) {
          console.error('Error saving proposal:', error);
          await ctx.reply(
            '❌ متاسفانه در ثبت پیشنهاد خطایی رخ داد. لطفا مجددا تلاش کنید.',
            mainKeyboard
          );
        }

        return ctx.scene.leave();
      }
    }

    await ctx.reply('لطفاً یکی از دکمه‌های بالا را جهت تایید نهایی انتخاب کنید.');
  }
);
