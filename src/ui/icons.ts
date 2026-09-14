/**
 * One icon vocabulary for the whole bot.
 *
 * Icons previously appeared inline at each call site, so the same idea picked up
 * different glyphs on different screens: a confirmation was ✅ in one place and 🤝 in
 * another, and 🔹 was used as a bullet, a status marker and a decoration. An icon is
 * only useful if it means one thing everywhere, so they are named by meaning here and
 * never typed literally into a message.
 */
export const Icon = {
  // trade direction
  buy: '🟢',
  sell: '🔴',

  // lifecycle
  pending: '⏳',
  approved: '✅',
  rejected: '❌',
  locked: '🔒',
  completed: '🤝',
  expired: '⏰',
  escalated: '🚨',

  // progress markers, used only in the deal card timeline
  stepDone: '✅',
  stepCurrent: '🔵',
  stepTodo: '⚪️',

  // actions
  send: '📤',
  edit: '✏️',
  remove: '🗑',
  refresh: '🔄',
  back: '◀️',
  cancel: '✖️',
  dispute: '🆘',
  support: '💬',

  // objects
  money: '💰',
  rate: '💵',
  receipt: '🧾',
  ad: '📋',
  deals: '📊',
  user: '👤',
  document: '🪪',
  rules: '📜',
  settings: '⚙️',
  shield: '🛡',
  warning: '⚠️',
  clock: '🕒'
} as const;

export type IconName = keyof typeof Icon;
