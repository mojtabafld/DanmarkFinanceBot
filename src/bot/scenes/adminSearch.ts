import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { mainKeyboard } from '../utils/keyboards';
import { escapeHtml } from '../utils/html';

export const ADMIN_SEARCH_SCENE_ID = 'ADMIN_SEARCH_SCENE';

export interface AdminSearchContext extends Scenes.WizardContext {}

export const adminSearchWizard = new Scenes.WizardScene<AdminSearchContext>(
  ADMIN_SEARCH_SCENE_ID,
  
  // Step 1: Prompt for search term
  async (ctx) => {
    await ctx.reply(
      '🔍 <b>جستجوی کاربر</b>\n\n' +
      'لطفاً نام واقعی، نام کاربری (بدون @)، شماره تماس یا شناسه عددی تلگرام کاربر مورد نظر را ارسال کنید:',
      Markup.keyboard([['❌ انصراف']]).resize().oneTime()
    );
    return ctx.wizard.next();
  },
  
  // Step 2: Handle search term and search DB
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('⚠️ لطفاً یک متن جهت جستجو وارد کنید:');
      return;
    }
    
    const query = ctx.message.text.trim();
    if (query === '❌ انصراف' || query === '/cancel') {
      await ctx.reply('❌ عملیات جستجو لغو شد.', mainKeyboard);
      return ctx.scene.leave();
    }
    
    if (query.length < 2) {
      await ctx.reply('⚠️ عبارت جستجو باید حداقل ۲ کاراکتر باشد. لطفاً مجدداً تلاش کنید:');
      return;
    }
    
    try {
      const users = await prisma.user.findMany({
        where: {
          OR: [
            { fullName: { contains: query, mode: 'insensitive' } },
            { username: { contains: query, mode: 'insensitive' } },
            { phoneNumber: { contains: query, mode: 'insensitive' } },
            { telegramId: { contains: query, mode: 'insensitive' } },
            { firstName: { contains: query, mode: 'insensitive' } },
            { lastName: { contains: query, mode: 'insensitive' } }
          ]
        },
        take: 15
      });
      
      if (users.length === 0) {
        await ctx.reply(
          `❌ هیچ کاربری منطبق با عبارت "${query}" یافت نشد.`,
          mainKeyboard
        );
        return ctx.scene.leave();
      }
      
      const buttons = users.map(u => [
        Markup.button.callback(
          `${escapeHtml(u.fullName || u.firstName)} (@${escapeHtml(u.username || 'ندارد')}) [${u.verificationStatus}]`,
          `ADMIN_USER_VIEW_${u.id}`
        )
      ]);
      buttons.push([Markup.button.callback('🔙 بازگشت به منوی ادمین', 'ADMIN_MAIN_MENU')]);
      
      await ctx.reply(
        `🔍 نتایج جستجو برای "${query}" (${users.length} مورد یافت شد):`,
        Markup.inlineKeyboard(buttons)
      );
      
      await ctx.reply('نتایج جستجو بارگذاری شد. لطفاً یکی از کاربران بالا را برای مشاهده جزئیات انتخاب کنید.', mainKeyboard);
      return ctx.scene.leave();
    } catch (error) {
      console.error('Error searching users:', error);
      await ctx.reply('❌ خطا در جستجوی کاربران.', mainKeyboard);
      return ctx.scene.leave();
    }
  }
);
