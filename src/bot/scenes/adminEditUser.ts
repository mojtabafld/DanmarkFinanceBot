import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { config } from '../../config';

const mainKeyboard = Markup.keyboard([
  ['📝 ثبت پیشنهاد جدید'],
  ['📋 پیشنهادهای فعال من', '❓ راهنما']
]).resize();

export const ADMIN_EDIT_USER_SCENE_ID = 'ADMIN_EDIT_USER_SCENE';
export const ADMIN_REJECT_USER_SCENE_ID = 'ADMIN_REJECT_USER_SCENE';

interface EditUserState {
  userId?: number;
  field?: 'fullName' | 'phoneNumber' | 'country' | 'dailyProposalLimit' | 'verificationStatus';
}

export interface MyEditUserContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: EditUserState;
  };
}

// 1. Wizard for editing specific fields of a user
export const adminEditUserWizard = new Scenes.WizardScene<MyEditUserContext>(
  ADMIN_EDIT_USER_SCENE_ID,
  
  // Step 1: Prompt for new value
  async (ctx) => {
    const state = ctx.scene.state as EditUserState;
    ctx.wizard.state.userId = state.userId;
    ctx.wizard.state.field = state.field;
    
    const userId = state.userId;
    const field = state.field;
    
    if (!userId || !field) {
      await ctx.reply('❌ اطلاعات کاربر یا فیلد مورد نظر نامعتبر است.');
      return ctx.scene.leave();
    }
    
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        await ctx.reply('❌ کاربر یافت نشد.');
        return ctx.scene.leave();
      }
      
      let promptText = '';
      let replyMarkup: any = Markup.keyboard([['❌ انصراف']]).resize().oneTime();
      
      switch (field) {
        case 'fullName':
          promptText = `✏️ **ویرایش نام واقعی**\n\nنام کنونی: <code>${user.fullName || 'ثبت نشده'}</code>\n\nلطفاً نام و نام خانوادگی جدید را تایپ کنید:`;
          break;
        case 'phoneNumber':
          promptText = `✏️ **ویرایش شماره تماس**\n\nشماره کنونی: <code>${user.phoneNumber || 'ثبت نشده'}</code>\n\nلطفاً شماره تماس جدید را تایپ کنید:`;
          break;
        case 'country':
          promptText = `✏️ **ویرایش کشور اقامت**\n\nکشور کنونی: <code>${user.country || 'ثبت نشده'}</code>\n\nلطفاً کشور جدید را تایپ کنید:`;
          break;
        case 'dailyProposalLimit':
          promptText = `✏️ **ویرایش محدودیت پیشنهاد روزانه**\n\nمحدودیت کنونی: <code>${user.dailyProposalLimit}</code> پیشنهاد در روز\n\nلطفاً عدد جدید را وارد کنید:`;
          break;
        case 'verificationStatus':
          promptText = `✏️ **ویرایش وضعیت احراز هویت**\n\nوضعیت کنونی: <code>${user.verificationStatus}</code>\n\nلطفاً وضعیت جدید را از دکمه‌های زیر انتخاب کنید:`;
          replyMarkup = undefined;
          await ctx.reply(promptText, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ تایید شده (APPROVED)', `EDIT_STATUS_SET_APPROVED`),
                Markup.button.callback('⏳ معلق (PENDING)', `EDIT_STATUS_SET_PENDING`)
              ],
              [
                Markup.button.callback('❌ رد صلاحیت شده (REJECTED)', `EDIT_STATUS_SET_REJECTED`)
              ],
              [Markup.button.callback('❌ انصراف', 'CANCEL_EDIT')]
            ])
          });
          return ctx.wizard.next();
      }
      
      await ctx.reply(promptText, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup?.reply_markup
      });
      return ctx.wizard.next();
    } catch (err) {
      console.error('Error in edit user step 1:', err);
      await ctx.reply('❌ خطایی رخ داد.');
      return ctx.scene.leave();
    }
  },
  
  // Step 2: Handle input and save
  async (ctx) => {
    const userId = ctx.wizard.state.userId;
    const field = ctx.wizard.state.field;
    
    if (!userId || !field) {
      await ctx.reply('❌ خطا: اطلاعات کاربر یافت نشد.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    
    if (field === 'verificationStatus' && ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();
      
      if (data === 'CANCEL_EDIT') {
        await ctx.reply('❌ عملیات لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }
      
      let newStatus = '';
      if (data === 'EDIT_STATUS_SET_APPROVED') newStatus = 'APPROVED';
      else if (data === 'EDIT_STATUS_SET_PENDING') newStatus = 'PENDING';
      else if (data === 'EDIT_STATUS_SET_REJECTED') newStatus = 'REJECTED';
      
      if (newStatus) {
        try {
          if (newStatus === 'REJECTED') {
            // Rejections are handled by the dedicated reject wizard to ask for reason!
            await ctx.reply('جهت رد صلاحیت کاربر، باید علت آن مشخص شود. ورود به بخش ثبت علت...');
            return ctx.scene.enter(ADMIN_REJECT_USER_SCENE_ID, { userId });
          }

          const user = await prisma.user.update({
            where: { id: userId },
            data: { verificationStatus: newStatus }
          });
          
          await ctx.reply(`✅ وضعیت کاربر **${user.fullName || user.firstName}** با موفقیت به **${newStatus}** تغییر یافت.`);
          
          // If approved, let's also issue an invite link if they were not already approved
          if (newStatus === 'APPROVED') {
            const inviteLink = await ctx.telegram.createChatInviteLink(config.GROUP_CHAT_ID, {
              member_limit: 1,
              name: `Invite for ${user.fullName}`,
              expire_date: Math.floor(Date.now() / 1000) + 86400
            });
            await ctx.telegram.sendMessage(
              user.telegramId,
              `🎉 **وضعیت احراز هویت شما تغییر یافت!**\n\n` +
              `مدیریت وضعیت شما را به «تایید شده» تغییر داد.\n` +
              `لینک عضویت یک‌بار مصرف شما در گروه معاملاتی (دارای اعتبار ۲۴ ساعته):\n` +
              `🔗 ${inviteLink.invite_link}\n\n` +
              `پس از عضویت در گروه، می‌توانید پیشنهادهای خود را از دکمه‌های زیر ثبت و مدیریت کنید.`,
              {
                parse_mode: 'Markdown',
                ...mainKeyboard
              }
            ).catch(() => {});
          }

          await ctx.reply(
            'مشخصات بروز شده کاربر:',
            Markup.inlineKeyboard([[Markup.button.callback('👤 مشاهده مشخصات کاربر', `ADMIN_USER_VIEW_${user.id}`)]])
          );
        } catch (error) {
          console.error('Error updating status:', error);
          await ctx.reply('❌ خطا در بروزرسانی وضعیت.');
        }
      }
      return ctx.scene.leave();
    }
    
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '❌ انصراف' || text === '/cancel') {
        await ctx.reply('❌ عملیات لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }
      
      let updateData: any = {};
      
      if (field === 'fullName') {
        if (text.length < 3) {
          await ctx.reply('⚠️ نام باید حداقل ۳ کاراکتر باشد. لطفاً مجدداً وارد کنید:');
          return;
        }
        updateData = { fullName: text };
      } else if (field === 'phoneNumber') {
        updateData = { phoneNumber: text };
      } else if (field === 'country') {
        updateData = { country: text };
      } else if (field === 'dailyProposalLimit') {
        const limit = parseInt(text, 10);
        if (isNaN(limit) || limit < 0) {
          await ctx.reply('⚠️ لطفا یک عدد صحیح بزرگتر یا مساوی صفر وارد کنید:');
          return;
        }
        updateData = { dailyProposalLimit: limit };
      }
      
      try {
        const user = await prisma.user.update({
          where: { id: userId },
          data: updateData
        });
        
        await ctx.reply(`✅ ویرایش با موفقیت انجام شد.`, Markup.removeKeyboard());
        await ctx.reply(
          `مشخصات جدید کاربر **${user.fullName || user.firstName}** ثبت شد.`,
          Markup.inlineKeyboard([[Markup.button.callback('👤 مشاهده مشخصات کاربر', `ADMIN_USER_VIEW_${user.id}`)]])
        );
      } catch (error) {
        console.error('Error saving edited user field:', error);
        await ctx.reply('❌ خطا در ذخیره ویرایش.', Markup.removeKeyboard());
      }
      return ctx.scene.leave();
    }
    
    await ctx.reply('لطفاً مقدار معتبری بنویسید یا روی انصراف کلیک کنید.');
  }
);


interface RejectUserState {
  userId?: number;
}

export interface MyRejectUserContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: RejectUserState;
  };
}

// 2. Wizard to handle user rejection / revocation and ask for reason
export const adminRejectUserWizard = new Scenes.WizardScene<MyRejectUserContext>(
  ADMIN_REJECT_USER_SCENE_ID,
  
  // Step 1: Prompt for rejection reason
  async (ctx) => {
    const state = ctx.scene.state as RejectUserState;
    ctx.wizard.state.userId = state.userId;
    
    const userId = state.userId;
    if (!userId) {
      await ctx.reply('❌ اطلاعات کاربر نامعتبر است.');
      return ctx.scene.leave();
    }
    
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        await ctx.reply('❌ کاربر یافت نشد.');
        return ctx.scene.leave();
      }
      
      await ctx.reply(
        `🚫 **رد صلاحیت و لغو تاییدیه کاربر: ${user.fullName || user.firstName}**\n\n` +
        `لطفاً علت رد صلاحیت کاربر را تایپ و ارسال کنید تا به اطلاع او برسد:\n\n` +
        `💡 یا یکی از گزینه‌های پایین صفحه را انتخاب کنید:`,
        Markup.keyboard([
          ['مدارک ناخوانا یا ناقص است'],
          ['اطلاعات وارد شده مغایرت دارد'],
          ['عدم رعایت قوانین گروه معاملاتی'],
          ['❌ انصراف']
        ]).resize().oneTime()
      );
      return ctx.wizard.next();
    } catch (err) {
      console.error('Error starting rejection wizard:', err);
      await ctx.reply('❌ خطایی رخ داد.');
      return ctx.scene.leave();
    }
  },
  
  // Step 2: Receive reason, update DB, notify and kick user
  async (ctx) => {
    const userId = ctx.wizard.state.userId;
    if (!userId) {
      await ctx.reply('❌ اطلاعات کاربر یافت نشد.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    
    if (ctx.message && 'text' in ctx.message) {
      const reason = ctx.message.text.trim();
      if (reason === '❌ انصراف' || reason === '/cancel') {
        await ctx.reply('❌ عملیات رد درخواست لغو شد.', Markup.removeKeyboard());
        return ctx.scene.leave();
      }
      
      try {
        const user = await prisma.user.update({
          where: { id: userId },
          data: {
            verificationStatus: 'REJECTED',
            rejectReason: reason
          }
        });
        
        // Notify the User
        const userMsg =
          `❌ **درخواست احراز هویت شما مورد تایید قرار نگرفت.**\n\n` +
          `💬 **علت رد درخواست:** ${reason}\n\n` +
          `شما می‌توانید با زدن دکمه «🔐 شروع احراز هویت» مجدداً تلاش کرده و مدارک معتبر ارسال کنید.`;
        
        await ctx.telegram.sendMessage(user.telegramId, userMsg).catch(() => {});
        
        // Kick from Telegram Group
        const tgId = parseInt(user.telegramId, 10);
        await ctx.telegram.banChatMember(config.GROUP_CHAT_ID, tgId).catch(() => {});
        await ctx.telegram.unbanChatMember(config.GROUP_CHAT_ID, tgId).catch(() => {});
        
        await ctx.reply(
          `🚫 درخواست کاربر **${user.fullName || user.firstName}** رد شد، علت برای وی ارسال و از گروه معاملاتی اخراج گردید.`,
          Markup.removeKeyboard()
        );
        
        await ctx.reply(
          'مشخصات بروز شده کاربر:',
          Markup.inlineKeyboard([[Markup.button.callback('👤 مشاهده مشخصات کاربر', `ADMIN_USER_VIEW_${user.id}`)]])
        );
        
      } catch (error) {
        console.error('Error rejecting user in wizard:', error);
        await ctx.reply('❌ خطا در رد درخواست کاربر.', Markup.removeKeyboard());
      }
      return ctx.scene.leave();
    }
    
    await ctx.reply('لطفاً یک متن به عنوان علت ارسال کنید یا روی انصراف کلیک کنید.');
  }
);
