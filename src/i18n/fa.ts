/**
 * Persian copy. Keys are dotted and grouped by surface.
 *
 * Wording rule for anything a trader reads: say what happens next and who we are
 * waiting for, not only what just happened. "Pending admin approval" leaves someone
 * who has just sent money with no idea whether to worry.
 */
export const fa = {
  // ---- deal card ----
  'card.title.buy': '🟢 خرید {currency}',
  'card.title.sell': '🔴 فروش {currency}',
  'card.code': 'کد حواله',
  'card.amount': 'مقدار',
  'card.rate': 'نرخ واحد',
  'card.total': 'مبلغ کل',
  'card.counterparty': 'طرف معامله',
  'card.progress': 'مراحل معامله',
  'card.deadline': 'مهلت این مرحله',
  'card.deadline.passed': '⚠️ مهلت این مرحله گذشته و موضوع به مدیریت ارجاع شده است.',
  'card.role.buyer': 'شما خریدار هستید',
  'card.role.seller': 'شما فروشنده هستید',

  // ---- deal card: whose turn ----
  'card.await.you.pay.buyer': '👈 نوبت شماست: مبلغ را واریز کرده و تصویر فیش را بفرستید.',
  'card.await.you.pay.seller': '👈 نوبت شماست: ارز را منتقل کرده و تصویر رسید را بفرستید.',
  'card.await.admin': '⏳ در انتظار بررسی مدیریت. تا {deadline} پاسخ داده می‌شود.',
  'card.await.buyer': '⏳ در انتظار واریز خریدار. مهلت او تا {deadline} است.',
  'card.await.seller': '⏳ در انتظار انتقال ارز توسط فروشنده. مهلت او تا {deadline} است.',
  'card.done': '✅ این معامله با موفقیت تکمیل شد.',
  'card.rejected': '❌ این معامله لغو شد.',

  // ---- deal card: step names ----
  'step.PENDING_ADMIN': 'تایید مدیریت',
  'step.WAITING_BUYER_PAYMENT': 'واریز خریدار',
  'step.BUYER_PAID_PENDING_APPROVAL': 'بررسی فیش خریدار',
  'step.WAITING_SELLER_PAYMENT': 'انتقال فروشنده',
  'step.SELLER_PAID_PENDING_APPROVAL': 'بررسی رسید فروشنده',
  'step.COMPLETED': 'تکمیل',

  // ---- buttons ----
  'btn.send.receipt': '📤 ارسال فیش واریزی',
  'btn.dispute': '🆘 ثبت اعتراض',
  'btn.contact.admin': '💬 گفتگو با پشتیبانی',
  'btn.cancel': '✖️ انصراف',
  'btn.back': '◀️ بازگشت',
  'btn.confirm': '✅ تایید',
  'btn.reject': '❌ رد',
  'btn.refresh': '🔄 بروزرسانی',

  // ---- account closure ----
  'close.confirm.title': '🗑 <b>بستن حساب کاربری</b>',
  'close.confirm.body':
    'اطلاعات شخصی شما (نام، شماره تماس و کشور) پاک می‌شود.\n' +
    'تصویر مدرک هویتی شما هم از ربات و هم از گفتگوی مدیریت حذف می‌شود.\n\n' +
    'سابقه معاملات انجام‌شده شما پاک <b>نمی‌شود</b>، چون بخشی از سابقه طرف مقابل معامله هم هست و حذف آن حق ما نیست. این سابقه بدون اطلاعات شخصی شما نگهداری می‌شود.\n\n' +
    'آیا ادامه می‌دهید؟',
  'close.blocked':
    '⚠️ <b>در حال حاضر امکان بستن حساب نیست</b>\n\n' +
    'شما {count} معامله باز دارید (کد: {ids}).\n' +
    'تا زمانی که این معاملات تسویه نشده‌اند، حساب شما بسته نمی‌شود تا حقوق طرف مقابل محفوظ بماند.',
  'close.done':
    '🗑 <b>حساب شما بسته شد.</b>\n\n' +
    'اطلاعات شخصی و تصویر مدرک شما پاک شد؛ هم از ربات و هم از گفتگوی مدیریت.\n' +
    'سابقه معاملات تکمیل‌شده، بدون اطلاعات شخصی، برای طرف‌های مقابل باقی می‌ماند.',
  'close.notfound': '⚠️ حساب فعالی برای شما یافت نشد.',

  // ---- rate limiting ----
  'limit.hit': '⏱ تعداد درخواست‌های شما زیاد بود. لطفاً {seconds} ثانیه دیگر دوباره تلاش کنید.',

  // ---- deadlines ----
  'sla.remind.buyer':
    '⏰ <b>یادآوری پرداخت</b>\n\nبرای معامله {code} هنوز فیش واریزی ثبت نشده است.\n' +
    'مهلت شما تا {deadline} است. پس از آن معامله به مدیریت ارجاع می‌شود.',
  'sla.remind.seller':
    '⏰ <b>یادآوری انتقال ارز</b>\n\nخریدار معامله {code} وجه را پرداخت کرده است.\n' +
    'مهلت شما برای انتقال ارز تا {deadline} است.',
  'sla.escalated.user':
    '⚠️ <b>مهلت معامله {code} به پایان رسید</b>\n\n' +
    'موضوع به مدیریت ارجاع شد و به‌زودی با شما تماس گرفته می‌شود. نیازی به اقدام دیگری نیست.',
  'sla.escalated.admin':
    '🚨 <b>مهلت معامله سررسید شد</b>\n\n' +
    'معامله <code>#{dealId}</code> (آگهی {code}) از {hours} ساعت پیش در وضعیت <code>{status}</code> مانده است.\n' +
    'منتظر: {awaiting}\n{funds}',
  'sla.funds.committed': '💰 وجه خریدار پرداخت شده است؛ این مورد اولویت دارد.',
  'sla.funds.pending': 'هنوز وجهی جابه‌جا نشده است.',

  // ---- document retention ----
  'retention.notice':
    '🪪 مدرک شما حداکثر {hours} ساعت نگهداری و سپس به‌طور کامل حذف می‌شود؛ ' +
    'هم از ربات و هم از گفتگوی مدیریت.',
  'retention.user.purged':
    '🪪 <b>مدرک هویتی شما حذف شد</b>\n\n' +
    'طبق سیاست نگهداری اطلاعات، تصویر مدرک شما پس از {hours} ساعت از ربات و از گفتگوی مدیریت حذف شد.\n' +
    'وضعیت احراز هویت شما تغییری نکرده است.',
  'retention.user.stranded':
    '🪪 <b>مدرک هویتی شما حذف شد</b>\n\n' +
    'تصویر مدرک شما پس از {hours} ساعت طبق سیاست نگهداری اطلاعات حذف شد و هنوز بررسی نشده بود.\n' +
    'برای ادامه، لطفاً احراز هویت را دوباره آغاز کنید. عذرخواهی می‌کنیم که بررسی به‌موقع انجام نشد.',
  'retention.admin.reminder':
    '🪪 <b>یادآوری بررسی مدارک</b>\n\n' +
    '{count} درخواست احراز هویت هنوز بررسی نشده است.\n' +
    'مدارک آن‌ها تا حدود {hours} ساعت دیگر طبق سیاست نگهداری حذف می‌شود و کاربران باید از نو ارسال کنند.',

  // ---- generic ----
  'err.unexpected': '❌ خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.',
  'err.not.your.deal': '⚠️ این معامله متعلق به شما نیست.',
  'cancelled': '✖️ عملیات لغو شد.',
  'awaiting.admin': 'مدیریت',
  'awaiting.buyer': 'خریدار',
  'awaiting.seller': 'فروشنده',
  'awaiting.nobody': '—'
} as const;
