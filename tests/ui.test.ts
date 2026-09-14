import { describe, it, expect } from 'vitest';
import { renderDealCard, viewerRole, type DealCardModel } from '../src/ui/dealCard';
import { Action, data, parse, parseId, button } from '../src/ui/buttons';
import { Icon } from '../src/ui/icons';
import { t, raw, messageKeys } from '../src/i18n';
import type { DealStatus } from '@prisma/client';

const base: DealCardModel = {
  dealId: 42,
  code: '0007',
  type: 'SELL',
  currency: 'DKK',
  amount: 1000,
  unitPrice: 5000,
  status: 'WAITING_BUYER_PAYMENT',
  deadlineAt: new Date(Date.now() + 6 * 3600_000),
  counterpartyMention: '@trader',
  timeZone: 'Europe/Copenhagen'
};

function buttonLabels(card: ReturnType<typeof renderDealCard>): string[] {
  const rows = (card.keyboard.reply_markup as any).inline_keyboard as Array<Array<{ text: string }>>;
  return rows.flat().map(b => b.text);
}

describe('message catalogue', () => {
  it('escapes interpolated values by default', () => {
    const out = t('limit.hit', { seconds: '<b>9</b>' });
    expect(out).toContain('&lt;b&gt;9&lt;/b&gt;');
    expect(out).not.toContain('<b>9</b>');
  });

  it('lets pre-built markup through when marked raw', () => {
    const out = t('card.await.admin', { deadline: raw('<i>فردا</i>') });
    expect(out).toContain('<i>فردا</i>');
  });

  it('returns the key rather than throwing when a key is missing', () => {
    expect(t('nope.not.a.key' as any)).toBe('nope.not.a.key');
  });

  it('has a message for every lifecycle step and awaiting party', () => {
    const keys = messageKeys();
    for (const step of ['PENDING_ADMIN', 'WAITING_BUYER_PAYMENT', 'BUYER_PAID_PENDING_APPROVAL',
                        'WAITING_SELLER_PAYMENT', 'SELLER_PAID_PENDING_APPROVAL', 'COMPLETED']) {
      expect(keys, `step.${step}`).toContain(`step.${step}`);
    }
    for (const who of ['admin', 'buyer', 'seller', 'nobody']) {
      expect(keys).toContain(`awaiting.${who}`);
    }
  });
});

describe('typed callback actions', () => {
  it('round-trips an id', () => {
    expect(parseId(Action.adminApproveDeal, data(Action.adminApproveDeal, 42))).toBe(42);
  });

  it('does not match a different action', () => {
    expect(parse(Action.adminRejectDeal, data(Action.adminApproveDeal, 1))).toBeNull();
  });

  it('requires the separator, so one action cannot swallow a longer one', () => {
    expect(parse(Action.adminApproveDeal, `${Action.adminApproveDeal}ALL_1`)).toBeNull();
  });

  it('rejects an empty or non-numeric id', () => {
    expect(parse(Action.adminApproveDeal, `${Action.adminApproveDeal}_`)).toBeNull();
    expect(parseId(Action.adminApproveDeal, `${Action.adminApproveDeal}_abc`)).toBeNull();
  });

  it('builds a button whose data its own parser accepts', () => {
    const b = button('تایید', Action.adminConfirmBuyerReceipt, 9) as any;
    expect(parseId(Action.adminConfirmBuyerReceipt, b.callback_data)).toBe(9);
  });
});

describe('deal card', () => {
  it('shows the action button only to the side whose turn it is', () => {
    const buyer = renderDealCard(base, 'buyer');
    const seller = renderDealCard(base, 'seller');

    expect(buttonLabels(buyer)).toContain(t('btn.send.receipt'));
    expect(buttonLabels(seller)).not.toContain(t('btn.send.receipt'));
  });

  it('tells the waiting side who is holding things up', () => {
    const seller = renderDealCard(base, 'seller');
    expect(seller.text).toContain('در انتظار واریز خریدار');
  });

  it('offers a dispute only once the buyer has committed funds', () => {
    const before = renderDealCard(base, 'buyer');
    expect(buttonLabels(before)).not.toContain(t('btn.dispute'));

    const after = renderDealCard({ ...base, status: 'WAITING_SELLER_PAYMENT' }, 'buyer');
    expect(buttonLabels(after)).toContain(t('btn.dispute'));
  });

  it('marks progress up to the current step and no further', () => {
    const card = renderDealCard({ ...base, status: 'WAITING_SELLER_PAYMENT' }, 'buyer');
    const doneCount = (card.text.match(new RegExp(Icon.stepDone, 'g')) || []).length;
    // Three steps precede WAITING_SELLER_PAYMENT in the journey.
    expect(doneCount).toBe(3);
    expect(card.text).toContain(Icon.stepCurrent);
  });

  it('drops the progress strip and every button on a rejected deal', () => {
    const card = renderDealCard({ ...base, status: 'REJECTED', deadlineAt: null }, 'buyer');
    expect(card.text).toContain(t('card.rejected'));
    expect(card.text).not.toContain(Icon.stepCurrent);
    expect(buttonLabels(card)).toEqual([]);
  });

  it('says so when the deadline has already passed', () => {
    const card = renderDealCard({ ...base, deadlineAt: new Date(Date.now() - 3600_000) }, 'buyer');
    expect(card.text).toContain(t('card.deadline.passed'));
  });

  it('escapes a hostile counterparty name rather than breaking the message', () => {
    const card = renderDealCard({ ...base, currency: '<b>DKK' }, 'buyer');
    expect(card.text).toContain('&lt;b&gt;DKK');
  });

  it('renders a card for every lifecycle state without throwing', () => {
    const states: DealStatus[] = ['PENDING', 'PENDING_ADMIN', 'WAITING_BUYER_PAYMENT',
      'BUYER_PAID_PENDING_APPROVAL', 'WAITING_SELLER_PAYMENT', 'SELLER_PAID_PENDING_APPROVAL',
      'COMPLETED', 'REJECTED'];
    for (const status of states) {
      for (const viewer of ['buyer', 'seller'] as const) {
        const card = renderDealCard({ ...base, status }, viewer);
        expect(card.text.length, `${status}/${viewer}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('who is on which side of a trade', () => {
  it('makes the creator of a BUY ad the buyer', () => {
    expect(viewerRole('BUY', true)).toBe('buyer');
    expect(viewerRole('BUY', false)).toBe('seller');
  });

  it('makes the creator of a SELL ad the seller', () => {
    expect(viewerRole('SELL', true)).toBe('seller');
    expect(viewerRole('SELL', false)).toBe('buyer');
  });
});
