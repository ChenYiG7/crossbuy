/**
 * 通知渠道抽象（notify 基础设施包，非域——docs/04 §3.1）。
 *
 * 旧系统 Services/Notify（邮件 / 钉钉 / MNS）的接口面。实现类按渠道分文件落地
 * （M2/M3 随域铺开）；域服务只依赖本接口，事务内禁外呼——通知 AFTER_COMMIT
 * 或事件后再发，失败只记日志可补（docs/07 铁律 7）。
 */

/** 通知渠道类型（旧系统实际在用的三条 + 占位） */
export type NotifyChannelKind = 'email' | 'dingtalk' | 'mns';

/** 一条待发通知（渠道无关） */
export interface Notification {
  readonly channel: NotifyChannelKind;
  /** 渠道目标：邮箱 / 钉钉 webhook key / MNS topic */
  readonly target: string;
  readonly title?: string;
  readonly body: string;
}

/** 发送结果：可预期失败（渠道不可达等）走 Result，禁抛异常承载分支 */
export type NotifyResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; code: 'CHANNEL_UNAVAILABLE' | 'REJECTED' | 'RATE_LIMITED' | 'INTERNAL'; message: string };

/** 渠道实现接口（email / dingtalk / mns 各自实现） */
export interface NotifyChannel {
  readonly kind: NotifyChannelKind;
  send(notification: Notification): Promise<NotifyResult>;
}
