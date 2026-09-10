/**
 * Escapes the five characters Telegram's HTML parse mode treats as markup.
 *
 * Every value that originates from a user (names, usernames, countries, phone
 * numbers, bank details, rejection reasons) must pass through this before being
 * interpolated into a message sent with `parse_mode: 'HTML'`. An unescaped `<` or
 * `&` makes Telegram reject the whole message with a 400, which in the receipt flow
 * meant the admin never received the payment slip at all.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders a user as an HTML mention, escaping the display name and username. */
export function mentionUser(user: {
  username?: string | null;
  firstName?: string | null;
  telegramId: string;
}): string {
  if (user.username) return `@${escapeHtml(user.username)}`;
  const name = escapeHtml(user.firstName || 'کاربر');
  return `<a href="tg://user?id=${escapeHtml(user.telegramId)}">${name}</a>`;
}
