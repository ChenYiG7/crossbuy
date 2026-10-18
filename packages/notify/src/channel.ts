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
  | {
      ok: false;
      code: 'CHANNEL_UNAVAILABLE' | 'REJECTED' | 'RATE_LIMITED' | 'INTERNAL';
      message: string;
    };

/** 渠道实现接口（email / dingtalk / mns 各自实现） */
export interface NotifyChannel {
  readonly kind: NotifyChannelKind;
  send(notification: Notification): Promise<NotifyResult>;
}

/** 极简日志接口（dev 通道用，避免 notify 包直接依赖 pino） */
export interface NotifyLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

const consoleLogger: NotifyLogger = {
  info: (m, meta) => console.log(m, meta ?? ''),
  warn: (m, meta) => console.warn(m, meta ?? ''),
};

/**
 * dev 邮件通道（R1 占位，对标旧系统「开发环境不真发邮件」）。
 *
 * 不连任何 SMTP，只把待发通知打到日志并返回 `ok`——真实 SMTP 通道（R2/R3）按同接口替换，
 * 域/worker 代码零改动。失败只走 Result，禁抛异常承载分支（docs/07 铁律）。
 */
export function createConsoleNotifyChannel(logger: NotifyLogger = consoleLogger): NotifyChannel {
  return {
    kind: 'email',
    async send(notification: Notification): Promise<NotifyResult> {
      logger.info(`[notify:${notification.channel}] → ${notification.target}`, {
        title: notification.title ?? '',
        body: notification.body,
      });
      return { ok: true };
    },
  };
}
