import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';
import { verifyStartKeyboard, pendingVerificationKeyboard } from '../utils/keyboards';
import { maskImage } from '../utils/imageMasking';

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
  
  // Step 1: Start & Ask for Full Name (Requires Username)
  async (ctx) => {
    ctx.scene.state = {};
    ctx.wizard.state = ctx.scene.state;
    
    // Check if user has a username
    if (!ctx.from || !ctx.from.username) {
      await ctx.reply(
        '⚠️ کاربر گرامی، جهت احراز هویت لازم است که اکانت تلگرام شما دارای **نام کاربری (Username)** باشد.\n\n' +
        'لطفاً ابتدا به تنظیمات تلگرام خود رفته، یک نام کاربری برای خود تعریف کنید و سپس مجدداً احراز هویت را شروع کنید.',
        verifyStartKeyboard
      );
      return ctx.scene.leave();
    }

    try {
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: ctx.from.id.toString() }
      });

      if (dbUser?.verificationStatus === 'PENDING') {
        await ctx.reply(
          '⏳ مدارک احراز هویت شما در حال بررسی توسط مدیریت است. لطفا منتظر بمانید.',
          pendingVerificationKeyboard
        );
        return ctx.scene.leave();
      }

      if (dbUser?.verificationStatus === 'APPROVED') {
        await ctx.reply('✅ احراز هویت شما قبلا تایید شده است.', verifyStartKeyboard);
        return ctx.scene.leave();
      }
    } catch (err) {
      console.error('Error checking verification status in wizard start:', err);
    }

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
        await ctx.reply('❌ احراز هویت لغو شد. تا زمانی که احراز هویت نشوید امکان فعالیت ندارید.', verifyStartKeyboard);
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
            Markup.button.callback('🇮🇷 ایران', 'CURR_COUNTRY_IR'),
            Markup.button.callback('🇩🇰 دانمارک', 'CURR_COUNTRY_DK')
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
        await ctx.reply('❌ احراز هویت لغو شد.', verifyStartKeyboard);
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

      // If they chose DK or IR, ask for phone directly and jump to Step 4 (Index 3)
      await ctx.reply(
        '📱 اشتراک‌گذاری شماره تماس:\n' +
        'لطفاً از دکمه زیر جهت ارسال شماره تلفن خود استفاده کنید تا هویت شما تایید شود.',
        Markup.keyboard([
          [Markup.button.contactRequest('📱 اشتراک‌گذاری شماره تماس')]
        ]).oneTime().resize()
      );
      return ctx.wizard.selectStep(3);
    }

    // If custom country was requested and they typed it
    if (ctx.wizard.state.needsCustomCountry && ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === 'انصراف' || text === '/cancel') {
        await ctx.reply('❌ احراز هویت لغو شد.', verifyStartKeyboard);
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
      return ctx.wizard.selectStep(3); // Go to Step 4 (which is index 3)
    }

    await ctx.reply('لطفاً یکی از گزینه‌های شیشه‌ای بالا را انتخاب کنید.');
  },

  // Step 4: Handle Phone Contact & Ask for Photo
  async (ctx) => {
    const message = ctx.message;
    if (message && 'contact' in message) {
      ctx.wizard.state.phoneNumber = message.contact.phone_number;

      await ctx.reply(
        '📎 **ارسال مدرک اقامتی**\n\n' +
        'لطفاً تصویری واضح از **کارت اقامت (Residence Permit)** یا **کارت زرد سلامت (Sundhedskort)** خود ارسال کنید (عکس یا فایل).\n\n' +
        '🔒 **نکته امنیتی:** ربات به طور خودکار اطلاعات حساس تصویر (مانند کد ملی/شماره CPR و آدرس) را شناسایی و پوشش می‌دهد. پیش‌نمایش تصویر مخدوش‌شده قبل از ارسال نهایی برای ادمین به شما نشان داده خواهد شد تا آن را بررسی کنید. با این وجود، در صورت تمایل می‌توانید خودتان نیز با ابزارهای ادیت تلگرام روی این بخش‌ها را بپوشانید.',
        Markup.keyboard([['انصراف']]).oneTime().resize()
      );
      return ctx.wizard.next();
    }

    if (message && 'text' in message) {
      if (message.text === 'انصراف' || message.text === '/cancel') {
        await ctx.reply('❌ احراز هویت لغو شد.', verifyStartKeyboard);
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

  // Step 6: Handle Photo & Show Confirmation (With Automated Masking Preview)
  async (ctx) => {
    const message = ctx.message;
    if (!message) return;

    if ('text' in message) {
      if (message.text === 'انصراف' || message.text === '/cancel') {
        await ctx.reply('❌ احراز هویت لغو شد.', verifyStartKeyboard);
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

    const processingMsg = await ctx.reply('⏳ در حال پردازش تصویر و مخدوش‌سازی خودکار اطلاعات حساس (CPR و آدرس)... لطفاً چند لحظه صبر کنید.');

    let finalFileId = fileId;
    try {
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const maskedBuffer = await maskImage(fileLink.href);
      
      const previewPhoto = await ctx.replyWithPhoto(
        { source: maskedBuffer },
        {
          caption: '🛡️ **پیش‌نمایش تصویر مخدوش‌شده**\n\n' +
                   'بخش‌های حساس مدرک شما (مانند شماره شناسایی/CPR و آدرس) به صورت خودکار شناسایی و با کادرهای مشکی پوشانده شدند.\n' +
                   'این دقیقاً همان تصویری است که ادمین مشاهده خواهد کرد.'
        }
      );

      if (previewPhoto && previewPhoto.photo) {
        finalFileId = previewPhoto.photo[previewPhoto.photo.length - 1].file_id;
      }
    } catch (err) {
      console.error('Error during automatic image masking in Step 6:', err);
      await ctx.reply('⚠️ پردازش پیشرفته تصویر با خطا مواجه شد. مدرک شما بدون مخدوش‌سازی خودکار ثبت گردید.');
    } finally {
      try {
        await ctx.telegram.deleteMessage(ctx.chat!.id, processingMsg.message_id);
      } catch {}
    }

    ctx.wizard.state.documentFileId = finalFileId;

    const summaryText =
      `📋 **پیش‌نویس اطلاعات احراز هویت شما:**\n\n` +
      `🔹 **نام و نام خانوادگی:** ${ctx.wizard.state.fullName}\n` +
      `🔹 **کشور محل اقامت:** ${ctx.wizard.state.country}\n` +
      `🔹 **شماره تماس:** ${ctx.wizard.state.phoneNumber}\n` +
      `🔹 **نام کاربری تلگرام:** @${ctx.from?.username}\n\n` +
      `❓ آیا صحت این اطلاعات و مدرک پیش‌نمایش شده را تایید می‌کنید؟ در صورت تایید، درخواست برای مدیریت ارسال خواهد شد.`;

    await ctx.replyWithMarkdown(
      summaryText,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('تایید و ارسال', 'CONFIRM_VERIFICATION'),
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
        await ctx.reply('❌ احراز هویت لغو شد.', verifyStartKeyboard);
        return ctx.scene.leave();
      }

      if (data === 'CONFIRM_VERIFICATION') {
        const from = ctx.from;
        if (!from) return ctx.scene.leave();

        try {
          const fileIdToSave = ctx.wizard.state.documentFileId;

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
              documentFileId: fileIdToSave,
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
              documentFileId: fileIdToSave,
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
            `👇 تصویر مدرک پیوست شده است (بخش‌های شناسایی و آدرس به صورت خودکار پوشانده شده‌اند):`;

          // Send details and photo to Admin (using the already uploaded masked photo)
          const sentTextMsg = await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, adminMsg, { parse_mode: 'Markdown' });
          
          let sentPhotoMsg;
          if (fileIdToSave) {
            sentPhotoMsg = await ctx.telegram.sendPhoto(
              config.ADMIN_CHAT_ID,
              fileIdToSave,
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
          } else {
            throw new Error('No document file ID stored in wizard state.');
          }

          // Update user in DB with the admin verify message IDs
          await prisma.user.update({
            where: { id: dbUser.id },
            data: {
              adminVerifyMsgId: sentTextMsg.message_id,
              adminVerifyPhotoId: sentPhotoMsg.message_id,
            }
          });

          await ctx.reply(
            '✅ مدارک شما با موفقیت برای مدیریت ارسال شد.\n' +
            '⏳ درخواست شما پس از بررسی توسط ادمین پاسخ داده خواهد شد و نتیجه از همین‌جا اطلاع‌رسانی می‌شود.',
            pendingVerificationKeyboard
          );

        } catch (error) {
          console.error('Error in verification confirmation:', error);
          await ctx.reply('❌ در ارسال مدارک خطایی رخ داد. لطفا دوباره تلاش کنید.', verifyStartKeyboard);
        }

        return ctx.scene.leave();
      }
    }

    await ctx.reply('لطفاً یکی از دکمه‌های بالا را انتخاب کنید.');
  }
);
