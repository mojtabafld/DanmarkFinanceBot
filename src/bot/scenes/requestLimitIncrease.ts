import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { mainKeyboard } from '../utils/keyboards';

interface LimitState {
  userMessage?: string;
}

export interface MyLimitContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: LimitState;
  };
}

export const REQUEST_LIMIT_INCREASE_SCENE_ID = 'REQUEST_LIMIT_INCREASE_SCENE';

export const requestLimitIncreaseWizard = new Scenes.WizardScene<MyLimitContext>(
  REQUEST_LIMIT_INCREASE_SCENE_ID,

  // Step 1: Prompt for message
  async (ctx) => {
    ctx.wizard.state = {};
    const from = ctx.from;
    if (!from) return ctx.scene.leave();

    try {
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: from.id.toString() }
      });

      if (dbUser && dbUser.dailyProposalLimit >= 10) {
        await ctx.reply('⚠️ درخواست افزایش سقف روزانه شما قبلاً تایید شده است.', mainKeyboard);
        return ctx.scene.leave();
      }
    } catch (err) {
      console.error('Error checking user limit in wizard start:', err);
    }

    await ctx.reply(
      `📈 **درخواست افزایش سقف آگهی روزانه**\n\n` +
      `درخواست شما ثبت شد. در صورتی که می‌خواهید پیغامی برای ادمین بفرستید، متن خود را وارد کنید و روی دکمه ارسال ضربه بزنید. در غیر این صورت می‌توانید دکمه «ارسال درخواست افزایش سقف ثبت آگهی روزانه» را انتخاب کنید:`,
      Markup.keyboard([
        ['ارسال درخواست افزایش سقف ثبت آگهی روزانه'],
        ['انصراف']
      ]).resize().oneTime()
    );
    return ctx.wizard.next();
  },

  // Step 2: Handle input and send request to Admin
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();

      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ درخواست لغو شد.', mainKeyboard);
        return ctx.scene.leave();
      }

      const userMessage = text === 'ارسال درخواست افزایش سقف ثبت آگهی روزانه' ? 'بدون پیام' : text;
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

        const userMention = dbUser.username 
          ? `@${dbUser.username}` 
          : `<a href="tg://user?id=${dbUser.telegramId}">${dbUser.firstName}</a>`;

        const adminMsgText =
          `🔔 <b>درخواست افزایش سقف آگهی روزانه</b>\n\n` +
          `👤 <b>کاربر:</b> ${userMention}\n` +
          `📱 <b>تلفن:</b> <code>${dbUser.phoneNumber ?? '---'}</code>\n` +
          `🌍 <b>کشور:</b> <code>${dbUser.country ?? '---'}</code>\n` +
          `📈 <b>سقف فعلی:</b> <code>${dbUser.dailyProposalLimit}</code> آگهی\n` +
          `💬 <b>پیام کاربر:</b> ${userMessage}\n\n` +
          `❓ آیا با افزایش سقف روزانه این کاربر به ۱۰ موافقت می‌کنید؟`;

        await ctx.telegram.sendMessage(
          config.ADMIN_CHAT_ID,
          adminMsgText,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ موافقت و افزایش سقف', `ADMIN_APPROVE_LIMIT_${dbUser.id}`),
                Markup.button.callback('❌ مخالفت', `ADMIN_REJECT_LIMIT_${dbUser.id}`)
              ]
            ])
          }
        );

        await ctx.reply('✅ درخواست شما با موفقیت برای مدیریت ارسال شد. نتیجه به زودی به شما اطلاع داده خواهد شد.', mainKeyboard);

      } catch (err) {
        console.error('Error submitting limit request to admin:', err);
        await ctx.reply('❌ خطا در ارسال درخواست به مدیریت.', mainKeyboard);
      }

      return ctx.scene.leave();
    }

    await ctx.reply('لطفاً پیام خود را به صورت متنی وارد کنید یا دکمه‌های کیبورد را انتخاب کنید.');
  }
);
