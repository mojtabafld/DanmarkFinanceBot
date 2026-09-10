import { Scenes, Markup } from 'telegraf';
import { config } from '../../config';
import { mainKeyboard } from '../utils/keyboards';
import { formatToShamsi } from '../utils/groupMessage';

interface RatesState {
  dkk?: number;
  eur?: number;
  usd?: number;
}

export interface MyRatesWizardContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: RatesState;
  };
}

export const ADMIN_UPDATE_RATES_SCENE_ID = 'ADMIN_UPDATE_RATES_SCENE';

export const adminUpdateRatesWizard = new Scenes.WizardScene<MyRatesWizardContext>(
  ADMIN_UPDATE_RATES_SCENE_ID,

  // Step 1: Prompt for DKK rate
  async (ctx) => {
    ctx.scene.state = {};
    ctx.wizard.state = ctx.scene.state;
    const from = ctx.from;
    if (!from || from.id.toString() !== config.ADMIN_CHAT_ID.toString()) {
      await ctx.reply('⚠️ شما مجاز به استفاده از این سناریو نیستید.');
      return ctx.scene.leave();
    }

    await ctx.reply(
      `📊 <b>بروزرسانی نرخ‌های ارز</b>\n\n` +
      `لطفاً نرخ جدید <b>کرون دانمارک (DKK)</b> را به تومان وارد کنید:`,
      Markup.keyboard([['❌ انصراف']]).resize().oneTime()
    );
    return ctx.wizard.next();
  },

  // Step 2: Handle DKK and prompt for EUR
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات آپدیت نرخ ارز لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      const rate = parseFloat(text.replace(/,/g, ''));
      if (isNaN(rate) || rate <= 0) {
        await ctx.reply('⚠️ نرخ وارد شده نامعتبر است. لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }

      ctx.wizard.state.dkk = rate;

      await ctx.reply(
        `لطفاً نرخ جدید <b>یورو (EUR)</b> را به تومان وارد کنید:`,
        Markup.keyboard([['❌ انصراف']]).resize().oneTime()
      );
      return ctx.wizard.next();
    }
    await ctx.reply('لطفاً نرخ کرون را به صورت عدد ارسال کنید.');
  },

  // Step 3: Handle EUR and prompt for USD
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      const rate = parseFloat(text.replace(/,/g, ''));
      if (isNaN(rate) || rate <= 0) {
        await ctx.reply('⚠️ نرخ وارد شده نامعتبر است. لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }

      ctx.wizard.state.eur = rate;

      await ctx.reply(
        `لطفاً نرخ جدید <b>دلار آمریکا (USD)</b> را به تومان وارد کنید:`,
        Markup.keyboard([['❌ انصراف']]).resize().oneTime()
      );
      return ctx.wizard.next();
    }
    await ctx.reply('لطفاً نرخ یورو را به صورت عدد ارسال کنید.');
  },

  // Step 4: Handle USD and show preview
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      const rate = parseFloat(text.replace(/,/g, ''));
      if (isNaN(rate) || rate <= 0) {
        await ctx.reply('⚠️ نرخ وارد شده نامعتبر است. لطفا یک عدد بزرگتر از صفر وارد کنید:');
        return;
      }

      ctx.wizard.state.usd = rate;

      const dkk = ctx.wizard.state.dkk!;
      const eur = ctx.wizard.state.eur!;
      const usd = rate;
      const dateStr = formatToShamsi(new Date());

      const ratesText = 
        `📊 <b>نرخ لحظه‌ای ارزها - DanmarkFinance</b>\n\n` +
        `🇩🇰 <b>کرون دانمارک (DKK):</b> <code>${dkk.toLocaleString('fa-IR')}</code> تومان\n` +
        `🇪🇺 <b>یورو (EUR):</b> <code>${eur.toLocaleString('fa-IR')}</code> تومان\n` +
        `🇺🇸 <b>دلار آمریکا (USD):</b> <code>${usd.toLocaleString('fa-IR')}</code> تومان\n\n` +
        `📅 <b>تاریخ بروزرسانی:</b> <code>${dateStr}</code>`;

      await ctx.reply(
        `📋 <b>پیش‌نویس کارت نرخ ارز جهت ارسال به گروه:</b>\n\n` + ratesText + `\n\n❓ آیا تایید و ارسال می‌کنید؟`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ تایید و ارسال به گروه', 'CONFIRM_SEND_RATES'),
              Markup.button.callback('❌ انصراف', 'CANCEL_WIZARD')
            ]
          ])
        }
      );
      return ctx.wizard.next();
    }
    await ctx.reply('لطفاً نرخ دلار را به صورت عدد ارسال کنید.');
  },

  // Step 5: Handle Confirmation and post to group
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'CANCEL_WIZARD') {
        await ctx.reply('❌ عملیات لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      if (data === 'CONFIRM_SEND_RATES') {
        const dkk = ctx.wizard.state.dkk!;
        const eur = ctx.wizard.state.eur!;
        const usd = ctx.wizard.state.usd!;
        const dateStr = formatToShamsi(new Date());

        const ratesText = 
          `📊 <b>نرخ لحظه‌ای ارزها - DanmarkFinance</b>\n\n` +
          `🇩🇰 <b>کرون دانمارک (DKK):</b> <code>${dkk.toLocaleString('fa-IR')}</code> تومان\n` +
          `🇪🇺 <b>یورو (EUR):</b> <code>${eur.toLocaleString('fa-IR')}</code> تومان\n` +
          `🇺🇸 <b>دلار آمریکا (USD):</b> <code>${usd.toLocaleString('fa-IR')}</code> تومان\n\n` +
          `📅 <b>تاریخ بروزرسانی:</b> <code>${dateStr}</code>`;

        try {
          await ctx.telegram.sendMessage(config.GROUP_CHAT_ID, ratesText, { parse_mode: 'HTML' });
          await ctx.reply('✅ نرخ‌های جدید با موفقیت به گروه ارسال شدند.', mainKeyboard);
        } catch (err) {
          console.error('Failed to post rates to group:', err);
          await ctx.reply('❌ خطا در ارسال نرخ ارز به گروه.', mainKeyboard);
        }
        return ctx.scene.leave();
      }
    }
    await ctx.reply('لطفاً یکی از گزینه‌های بالا را انتخاب کنید.');
  }
);
