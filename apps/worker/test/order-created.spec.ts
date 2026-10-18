import { describe, expect, it } from 'vitest';
import { createInMemoryIdempotency } from '@crossbuy/cache';
import type { NotifyChannel, NotifyResult } from '@crossbuy/notify';
import { processOrderCreated, type OrderCreatedJobData } from '../src/jobs/order-created';

/** fake 邮件通道：记录所有出站通知，可注入失败结果 */
function fakeNotify() {
  const sent: Parameters<NotifyChannel['send']>[0][] = [];
  let next: NotifyResult = { ok: true };
  const channel: NotifyChannel = {
    kind: 'email',
    async send(n) {
      sent.push(n);
      return next;
    },
  };
  return { channel, sent, failWith: (r: NotifyResult) => (next = r) };
}

const base: OrderCreatedJobData = { uid: 100, orderIds: [1, 2], totalJpy: 5000, email: 'a@b.com' };

describe('processOrderCreated（单元：内存幂等 + fake 通道）', () => {
  it('正常：发送一封订单创建邮件，目标/标题/渠道正确', async () => {
    const { channel, sent } = fakeNotify();
    await processOrderCreated(base, { notify: channel, idempotency: createInMemoryIdempotency() });
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe('email');
    expect(sent[0].target).toBe('a@b.com');
    expect(sent[0].title).toContain('订单已提交');
    expect(sent[0].body).toContain('5,000');
  });

  it('★ 幂等：同 uid+orderIds 只发一次（乱序同集视为同一事件）', async () => {
    const { channel, sent } = fakeNotify();
    const idem = createInMemoryIdempotency();
    await processOrderCreated(base, { notify: channel, idempotency: idem });
    await processOrderCreated({ ...base, orderIds: [2, 1] }, { notify: channel, idempotency: idem });
    // 另一组不同订单 → 才发第二封
    await processOrderCreated({ ...base, uid: 200 }, { notify: channel, idempotency: idem });
    expect(sent).toHaveLength(2);
  });

  it('无邮箱：不发信、不抛错（不是可重试错误，无需重投）', async () => {
    const { channel, sent } = fakeNotify();
    await processOrderCreated(
      { ...base, email: '' },
      { notify: channel, idempotency: createInMemoryIdempotency() },
    );
    expect(sent).toHaveLength(0);
  });

  it('★ 守卫：渠道失败抛错，且 forget 标记使 BullMQ 能重试而非判「已处理」跳过', async () => {
    const { channel, sent, failWith } = fakeNotify();
    failWith({ ok: false, code: 'CHANNEL_UNAVAILABLE', message: 'down' });
    const idem = createInMemoryIdempotency();
    await expect(
      processOrderCreated(base, { notify: channel, idempotency: idem }),
    ).rejects.toThrow(/邮件发送失败/);
    expect(sent).toHaveLength(1); // 确实尝试发送过一次
    // 标记被清除 ⇒ 重试可再次发送（不卡在「已处理」）
    expect(await idem.has('order-created:100:1,2')).toBe(false);
  });
});
