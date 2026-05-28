import { Scenes, Markup } from 'telegraf';
import { prisma } from '../../database/db';
import { mainKeyboard } from '../utils/keyboards';
import { updateGroupProposalMessage } from '../utils/groupMessage';

export const MANAGE_ADS_SCENE_ID = 'MANAGE_ADS_SCENE';

export interface MyManageAdsContext extends Scenes.WizardContext {
  wizard: Scenes.WizardContext['wizard'] & {
    state: {
      selectedProposalId?: number;
    };
  };
}

const manageAdsMenuKeyboard = Markup.keyboard([
  ['➕ ثبت آگهی جدید'],
  ['⚙️ مدیریت آگهی‌های فعال', '📦 آرشیو آگهی‌ها'],
  ['🔙 بازگشت به منوی اصلی']
]).resize();

async function handleMenuText(ctx: MyManageAdsContext) {
  if (!ctx.message || !('text' in ctx.message)) return;
  const text = ctx.message.text.trim();

  if (text === '🔙 بازگشت به منوی اصلی' || text === '/cancel') {
    await ctx.reply('🔙 به منوی اصلی بازگشتید.', mainKeyboard);
    return ctx.scene.leave();
  }

  if (text === '➕ ثبت آگهی جدید') {
    await ctx.scene.enter('CREATE_PROPOSAL_SCENE');
    return;
  }

  if (text === '📦 آرشیو آگهی‌ها') {
    try {
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: ctx.from!.id.toString() }
      });
      if (!dbUser) return ctx.scene.leave();

      const archived = await prisma.proposal.findMany({
        where: {
          creatorId: dbUser.id,
          status: { in: ['COMPLETED', 'CANCELLED'] }
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      });

      if (archived.length === 0) {
        await ctx.reply('⚠️ شما هیچ آگهی آرشیو شده‌ای ندارید.', manageAdsMenuKeyboard);
        return;
      }

      let summary = `📦 **آرشیو آگهی‌های شما (تا ۱۰ آگهی آخر):**\n\n`;
      archived.forEach(prop => {
        const typeText = prop.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';
        const statusText = prop.status === 'COMPLETED' ? '✅ معامله شده' : '❌ لغو شده';
        summary += `🔹 **کد ${prop.code ?? prop.id}** | ${typeText} | مقدار: <code>${prop.amount.toLocaleString('fa-IR')}</code> ${prop.currency} | نرخ: <code>${prop.price.toLocaleString('fa-IR')}</code> تومان | وضعیت: ${statusText}\n\n`;
      });

      await ctx.replyWithHTML(summary, manageAdsMenuKeyboard);
    } catch (err) {
      console.error('Error fetching archived proposals:', err);
      await ctx.reply('❌ خطا در دریافت اطلاعات آرشیو.');
    }
    return;
  }

  if (text === '⚙️ مدیریت آگهی‌های فعال') {
    try {
      const dbUser = await prisma.user.findUnique({
        where: { telegramId: ctx.from!.id.toString() }
      });
      if (!dbUser) return ctx.scene.leave();

      const active = await prisma.proposal.findMany({
        where: {
          creatorId: dbUser.id,
          status: 'PENDING'
        },
        orderBy: { createdAt: 'desc' }
      });

      if (active.length === 0) {
        await ctx.reply('⚠️ شما در حال حاضر هیچ آگهی فعالی در گروه ندارید.', manageAdsMenuKeyboard);
        return;
      }

      const buttons = active.map(prop => {
        const typeText = prop.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';
        return [Markup.button.callback(
          `کد ${prop.code ?? prop.id} | ${typeText} | ${prop.amount.toLocaleString('fa-IR')} ${prop.currency}`,
          `SELECT_ACTIVE_AD_${prop.id}`
        )];
      });

      await ctx.reply(
        '👇 یکی از آگهی‌های فعال خود را جهت مدیریت انتخاب کنید:',
        {
          ...manageAdsMenuKeyboard,
          ...Markup.inlineKeyboard(buttons)
        }
      );
      return ctx.wizard.selectStep(1); // Go to Step 2 to handle callback queries
    } catch (err) {
      console.error('Error fetching active proposals:', err);
      await ctx.reply('❌ خطا در دریافت اطلاعات آگهی‌ها.');
    }
    return;
  }

  // Default fallback text
  await ctx.reply('📋 **منوی مدیریت آگهی‌های شما:**\nلطفاً یکی از گزینه‌های زیر را انتخاب کنید:', manageAdsMenuKeyboard);
}

export const manageAdsWizard = new Scenes.WizardScene<MyManageAdsContext>(
  MANAGE_ADS_SCENE_ID,

  // Step 1: Display Menu & Handle Keyboard Buttons
  async (ctx) => {
    ctx.wizard.state = {};
    if (ctx.message && 'text' in ctx.message) {
      return handleMenuText(ctx);
    }
    await ctx.reply('📋 **منوی مدیریت آگهی‌های شما:**\nلطفاً یکی از گزینه‌های زیر را انتخاب کنید:', manageAdsMenuKeyboard);
  },

  // Step 2: Handle Active Ads Selection, Edit and Delete Actions
  async (ctx) => {
    if (ctx.message && 'text' in ctx.message) {
      ctx.wizard.selectStep(0);
      return handleMenuText(ctx);
    }

    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (data === 'BACK_TO_ADS_LIST') {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { telegramId: ctx.from!.id.toString() }
          });
          if (!dbUser) return ctx.scene.leave();

          const active = await prisma.proposal.findMany({
            where: { creatorId: dbUser.id, status: 'PENDING' },
            orderBy: { createdAt: 'desc' }
          });

          if (active.length === 0) {
            await ctx.reply('⚠️ شما در حال حاضر هیچ آگهی فعالی در گروه ندارید.', manageAdsMenuKeyboard);
            ctx.wizard.selectStep(0);
            return;
          }

          const buttons = active.map(prop => {
            const typeText = prop.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';
            return [Markup.button.callback(
              `کد ${prop.code ?? prop.id} | ${typeText} | ${prop.amount.toLocaleString('fa-IR')} ${prop.currency}`,
              `SELECT_ACTIVE_AD_${prop.id}`
            )];
          });

          await ctx.reply('👇 یکی از آگهی‌های فعال خود را جهت مدیریت انتخاب کنید:', Markup.inlineKeyboard(buttons));
        } catch (err) {
          console.error('Error listing active ads again:', err);
        }
        return;
      }

      if (data.startsWith('SELECT_ACTIVE_AD_')) {
        const propId = parseInt(data.replace('SELECT_ACTIVE_AD_', ''), 10);
        if (isNaN(propId)) return;

        try {
          const prop = await prisma.proposal.findUnique({
            where: { id: propId }
          });

          if (!prop || prop.status !== 'PENDING') {
            await ctx.reply('⚠️ این آگهی دیگر فعال نیست.');
            return;
          }

          const typeText = prop.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';
          const details = 
            `📋 **جزئیات آگهی فعال شما:**\n\n` +
            `🔹 **کد آگهی:** ${prop.code ?? prop.id}\n` +
            `🔹 **نوع:** ${typeText}\n` +
            `🔹 **ارز:** ${prop.currency}\n` +
            `🔹 **مقدار فعلی:** <code>${prop.amount.toLocaleString('fa-IR')}</code> (از کل <code>${(prop.originalAmount ?? prop.amount).toLocaleString('fa-IR')}</code>)\n` +
            `🔹 **نرخ واحد:** <code>${prop.price.toLocaleString('fa-IR')}</code> تومان\n` +
            `🔹 **تسویه:** ${prop.paymentMethod || 'ثبت نشده'}\n\n` +
            `👇 عملیات مورد نظر خود را برای این آگهی انتخاب کنید:`;

          await ctx.replyWithHTML(
            details,
            Markup.inlineKeyboard([
              [
                Markup.button.callback('✏️ ویرایش آگهی', `EDIT_ACTIVE_AD_${prop.id}`),
                Markup.button.callback('❌ حذف و لغو آگهی', `DELETE_ACTIVE_AD_${prop.id}`)
              ],
              [Markup.button.callback('🔙 بازگشت به لیست آگهی‌ها', 'BACK_TO_ADS_LIST')]
            ])
          );
        } catch (err) {
          console.error('Error fetching proposal details:', err);
        }
        return;
      }

      if (data.startsWith('EDIT_ACTIVE_AD_')) {
        const propId = parseInt(data.replace('EDIT_ACTIVE_AD_', ''), 10);
        if (isNaN(propId)) return;

        await ctx.scene.enter('EDIT_PROPOSAL_SCENE', { proposalId: propId });
        return;
      }

      if (data.startsWith('DELETE_ACTIVE_AD_')) {
        const propId = parseInt(data.replace('DELETE_ACTIVE_AD_', ''), 10);
        if (isNaN(propId)) return;

        await ctx.reply(
          `⚠️ **حذف آگهی**\nآیا از حذف و لغو کامل آگهی کد #${propId} اطمینان دارید؟\nاین آگهی از گروه معاملاتی حذف خواهد شد.`,
          Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ بله، حذف کن', `CONFIRM_DELETE_AD_${propId}`),
              Markup.button.callback('❌ خیر، انصراف', `SELECT_ACTIVE_AD_${propId}`)
            ]
          ])
        );
        return;
      }

      if (data.startsWith('CONFIRM_DELETE_AD_')) {
        const propId = parseInt(data.replace('CONFIRM_DELETE_AD_', ''), 10);
        if (isNaN(propId)) return;

        try {
          const prop = await prisma.proposal.findUnique({
            where: { id: propId }
          });

          if (!prop || prop.status !== 'PENDING') {
            await ctx.reply('⚠️ این آگهی پیش از این غیرفعال یا حذف شده است.');
            return;
          }

          // Update proposal status in DB
          await prisma.proposal.update({
            where: { id: propId },
            data: { status: 'CANCELLED' }
          });

          // Update/Delete group message
          await updateGroupProposalMessage(ctx.telegram, propId);

          await ctx.reply('✅ آگهی شما با موفقیت حذف و از گروه لغو گردید.');

          // Redisplay list of active ads
          const dbUser = await prisma.user.findUnique({
            where: { telegramId: ctx.from!.id.toString() }
          });
          const active = await prisma.proposal.findMany({
            where: { creatorId: dbUser!.id, status: 'PENDING' },
            orderBy: { createdAt: 'desc' }
          });

          if (active.length === 0) {
            await ctx.reply('⚠️ شما دیگر هیچ آگهی فعالی ندارید.', manageAdsMenuKeyboard);
            ctx.wizard.selectStep(0);
          } else {
            const buttons = active.map(p => {
              const typeText = p.type === 'BUY' ? '🟢 خرید' : '🔴 فروش';
              return [Markup.button.callback(
                `کد ${p.code ?? p.id} | ${typeText} | ${p.amount.toLocaleString('fa-IR')} ${p.currency}`,
                `SELECT_ACTIVE_AD_${p.id}`
              )];
            });
            await ctx.reply('👇 لیست آگهی‌های فعال باقیمانده شما:', Markup.inlineKeyboard(buttons));
          }
        } catch (err) {
          console.error('Error deleting proposal:', err);
          await ctx.reply('❌ خطا در حذف آگهی.');
        }
        return;
      }
    }
  }
);
