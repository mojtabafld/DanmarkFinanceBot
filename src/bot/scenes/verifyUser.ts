import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';

interface VerifyState {
  fullName?: string;
  country?: string;
  phoneNumber?: string;
  documentFileId?: string;
  needsCustomCountry?: boolean;
}

export interface MyVerifyContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: VerifyState;
  };
}

export const VERIFY_USER_SCENE_ID = 'VERIFY_USER_SCENE';

export const verifyUserWizard = new Scenes.WizardScene<MyVerifyContext>(
  VERIFY_USER_SCENE_ID,
  
  // Step 1: Start & Ask for Full Name
  async (ctx) => {
    ctx.wizard.state = {};
    await ctx.reply(
      '🌟 به بخش احراز هویت خوش آمدید.\n' +
      'لطفاً جهت استفاده از امکانات ربات و عضویت در گروه، اطلاعات خود را به دقت وارد کنید.\n\n' +
      '👤 نام و نام خانوادگی واقعی خود را وارد کنید:',
      Markup.keyboard([['انصراف']]).oneTime().resize()
    );
    return ctx.wizard.next();
  },

  // Step 2: Handle Name & Ask for Country
  async (ctx) => {
    if ('text' in ctx.message!) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ احراز هویت لغو شد. تا زمانی که احراز هویت نشوید امکان فعالیت ندارید.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }

      if (text.length < 3) {
        await ctx.reply('⚠️ لطفا نام واقعی و کامل خود را وارد کنید:');
        return;
      }

      ctx.wizard.state.fullName = text;

      await ctx.reply(
        '🌍 کشور محل اقامت خود را انتخاب کنید:',
        Markup.inlineKeyboard([
          [
            Markup.button.callback('🇩🇰 دانمارک', 'CURR_COUNTRY_DK'),
            Markup.button.callback('🇮🇷 ایران', 'CURR_COUNTRY_IR')
          ],
          [Markup.button.callback('🌍 سایر کشورها', 'CURR_COUNTRY_OTHER')],
          [Markup.button.callback('❌ انصراف', 'CANCEL_WIZARD')]
        ])
      );
      return ctx.wizard.next();
    }
    await ctx.reply('لطفاً نام خود را به صورت متنی وارد کنید.');
  },

  // Step 3: Handle Country Selection (DK/IR/Other)
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'CANCEL_WIZARD') {
        await ctx.reply('❌ احراز هویت لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }

      if (data === 'CURR_COUNTRY_DK') {
        ctx.wizard.state.country = 'دانمارک';
      } else if (data === 'CURR_COUNTRY_IR') {
        ctx.wizard.state.country = 'ایران';
      } else if (data === 'CURR_COUNTRY_OTHER') {
        ctx.wizard.state.needsCustomCountry = true;
        await ctx.reply('✍️ لطفاً نام کشور محل اقامت خود را تایپ کنید:');
        return; // Wait for typing in this step
      }

      // If they chose DK or IR, ask for phone directly and jump to Step 5
      await ctx.reply(
        '📱 اشتراک‌گذاری شماره تماس:\n' +
        'لطفاً از دکمه زیر جهت ارسال شماره تلفن خود استفاده کنید تا هویت شما تایید شود.',
        Markup.keyboard([
          [Markup.button.contactRequest('📱 اشتراک‌گذاری شماره تماس')]
        ]).oneTime().resize()
      );
      // Move to Step 5 (we skip Step 4 which is the custom country entry)
      return ctx.wizard.selectStep(4);
    }

    // If custom country was requested and they typed it
    if (ctx.wizard.state.needsCustomCountry && 'text' in ctx.message!) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ احراز هویت لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }

      ctx.wizard.state.country = text;
      ctx.wizard.state.needsCustomCountry = false;

      await ctx.reply(
        '📱 اشتراک‌گذاری شماره تماس:\n' +
        'لطفاً از دکمه زیر جهت ارسال شماره تلفن خود استفاده کنید تا هویت شما تایید شود.',
        Markup.keyboard([
          [Markup.button.contactRequest('📱 اشتراک‌گذاری شماره تماس')]
        ]).oneTime().resize()
      );
      return ctx.wizard.next(); // Go to Step 4 (which is index 3)
    }

    await ctx.reply('لطفاً یکی از گزینه‌های شیشه‌ای بالا را انتخاب کنید.');
  },

  // Step 4: Fallback for custom country typing step
  async (ctx) => {
    if ('text' in ctx.message!) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ احراز هویت لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }

      ctx.wizard.state.country = text;
      await ctx.reply(
        '📱 اشتراک‌گذاری شماره تماس:\n' +
        'لطفاً از دکمه زیر جهت ارسال شماره تلفن خود استفاده کنید تا هویت شما تایید شود.',
        Markup.keyboard([
          [Markup.button.contactRequest('📱 اشتراک‌گذاری شماره تماس')]
        ]).oneTime().resize()
      );
      return ctx.wizard.next();
    }
    await ctx.reply('لطفاً نام کشور را بنویسید.');
  },

  // Step 5: Handle Phone Contact & Ask for Photo
  async (ctx) => {
    const message = ctx.message;
    if (message && 'contact' in message) {
      ctx.wizard.state.phoneNumber = message.contact.phone_number;

      await ctx.reply(
        '📎 ارسال مدرک اقامتی:\n' +
        'لطفاً تصویری واضح از **کارت اقامت** یا **کارت زرد سلامت** خود ارسال کنید (عکس یا فایل):',
        Markup.keyboard([['انصراف']]).oneTime().resize()
      );
      return ctx.wizard.next();
    }

    if (message && 'text' in message) {
      if (message.text === 'انصراف' || message.text === '/cancel') {
        await ctx.reply('❌ احراز هویت لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }
    }

    await ctx.reply(
      '⚠️ لطفاً حتماً با کلیک روی دکمه بزرگ پایین صفحه شماره تماس خود را به اشتراک بگذارید.',
      Markup.keyboard([
        [Markup.button.contactRequest('📱 اشتراک‌گذاری شماره تماس')]
      ]).oneTime().resize()
    );
  },

  // Step 6: Handle Photo & Show Confirmation
  async (ctx) => {
    const message = ctx.message;
    if (!message) return;

    if ('text' in message) {
      if (message.text === 'انصراف' || message.text === '/cancel') {
        await ctx.reply('❌ احراز هویت لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }
      await ctx.reply('⚠️ لطفا تصویر مدرک خود را بفرستید (عکس بفرستید، نه متن):');
      return;
    }

    let fileId = '';
    if ('photo' in message) {
      fileId = message.photo[message.photo.length - 1].file_id;
    } else if ('document' in message) {
      fileId = message.document.file_id;
    }

    if (!fileId) {
      await ctx.reply('⚠️ مدرک ارسال شده نامعتبر است. لطفاً یک عکس واضح ارسال کنید:');
      return;
    }

    ctx.wizard.state.documentFileId = fileId;

    const summaryText =
      `📋 **پیش‌نویس اطلاعات احراز هویت شما:**\n\n` +
      `🔹 **نام و نام خانوادگی:** ${ctx.wizard.state.fullName}\n` +
      `🔹 **کشور محل اقامت:** ${ctx.wizard.state.country}\n` +
      `🔹 **شماره تماس:** ${ctx.wizard.state.phoneNumber}\n\n` +
      `❓ آیا صحت این اطلاعات را تایید می‌کنید؟ در صورت تایید مدارک برای مدیریت ارسال خواهد شد.`;

    await ctx.replyWithMarkdown(
      summaryText,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ تایید و ارسال برای مدیریت', 'CONFIRM_VERIFICATION'),
          Markup.button.callback('❌ انصراف', 'CANCEL_WIZARD')
        ]
      ])
    );
    return ctx.wizard.next();
  },

  // Step 7: Handle Confirmation & DB update & Notify Admin
  async (ctx) => {
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'CANCEL_WIZARD') {
        await ctx.reply('❌ احراز هویت لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }

      if (data === 'CONFIRM_VERIFICATION') {
        const from = ctx.from;
        if (!from) return ctx.scene.leave();

        try {
          // 1. Save user registration info
          const dbUser = await prisma.user.upsert({
            where: { telegramId: from.id.toString() },
            update: {
              username: from.username || null,
              firstName: from.first_name,
              lastName: from.last_name || null,
              verificationStatus: 'PENDING',
              fullName: ctx.wizard.state.fullName,
              country: ctx.wizard.state.country,
              phoneNumber: ctx.wizard.state.phoneNumber,
              documentFileId: ctx.wizard.state.documentFileId,
            },
            create: {
              telegramId: from.id.toString(),
              username: from.username || null,
              firstName: from.first_name,
              lastName: from.last_name || null,
              verificationStatus: 'PENDING',
              fullName: ctx.wizard.state.fullName,
              country: ctx.wizard.state.country,
              phoneNumber: ctx.wizard.state.phoneNumber,
              documentFileId: ctx.wizard.state.documentFileId,
            },
          });

          // 2. Format details for Admin
          const adminMention = from.username 
            ? `@${from.username}` 
            : `[${from.first_name}](tg://user?id=${from.id})`;

          const adminMsg =
            `🔔 **درخواست احراز هویت جدید**\n\n` +
            `👤 **کاربر:** ${adminMention}\n` +
            `📝 **نام کامل:** ${dbUser.fullName}\n` +
            `🌍 **کشور اقامت:** ${dbUser.country}\n` +
            `📱 **شماره تلفن:** ${dbUser.phoneNumber}\n` +
            `🆔 **شناسه عددی:** \`${dbUser.telegramId}\`\n\n` +
            `👇 تصویر مدرک پیوست شده است:`;

          // Send details and photo to Admin
          await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, adminMsg, { parse_mode: 'Markdown' });
          await ctx.telegram.sendPhoto(
            config.ADMIN_CHAT_ID,
            dbUser.documentFileId!,
            {
              caption: `👤 مدرک هویتی ${dbUser.fullName}\nآیا این کاربر تایید شود؟`,
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback('✅ تایید احراز هویت', `APPROVE_USER_${dbUser.id}`),
                  Markup.button.callback('❌ رد احراز هویت', `REJECT_USER_${dbUser.id}`)
                ]
              ])
            }
          );

          await ctx.reply(
            '✅ مدارک شما با موفقیت برای مدیریت ارسال شد.\n' +
            '⏳ درخواست شما پس از بررسی توسط ادمین پاسخ داده خواهد شد و نتیجه از همین‌جا اطلاع‌رسانی می‌شود.',
            Markup.removeKeyboard()
          );

        } catch (error) {
          console.error('Error in verification confirmation:', error);
          await ctx.reply('❌ در ارسال مدارک خطایی رخ داد. لطفا دوباره تلاش کنید.', Markup.removeKeyboard());
        }

        return ctx.scene.leave();
      }
    }

    await ctx.reply('لطفاً یکی از دکمه‌های بالا را انتخاب کنید.');
  }
);
