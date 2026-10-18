import { parseEnv } from '@crossbuy/config';
import { Worker } from 'bullmq';
import pino from 'pino';
import { createConnection, DEFAULT_JOB_OPTIONS, QUEUES } from '@crossbuy/jobs';
import { createConsoleNotifyChannel, type NotifyChannel } from '@crossbuy/notify';
import { createRedis, createRedisIdempotency, waitForRedis, type Redis } from '@crossbuy/cache';
import { processOrderCreated, type OrderCreatedJobData } from './jobs/order-created';

const env = parseEnv();
const logger = pino({ name: 'worker', level: env.NODE_ENV === 'production' ? 'info' : 'debug' });

const connection = createConnection(env.REDIS_URL);
const redis: Redis = createRedis(env.REDIS_URL);
const idempotency = createRedisIdempotency(redis);
const notify: NotifyChannel = createConsoleNotifyChannel({
  info: (m, meta) => logger.info(meta ?? {}, m),
  warn: (m, meta) => logger.warn(meta ?? {}, m),
});

// 优雅关闭：SIGTERM/SIGINT 时先 drain 在途 job 再退出（BullMQ 已 ack 的不会重跑；
// 在途 job 会被重新排队给别的 worker，不会丢，只是会重跑——所以每个 job 必须幂等）。
const workers: Worker[] = [];
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker 收到关闭信号，drain 在途任务…');
  await Promise.all(workers.map((w) => w.close()));
  await redis.quit();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// ping 连通性探针（部署健康检查用，保留；真实 Job 走下面的 orderCreated）
new Worker(
  QUEUES.ping,
  async (job) => {
    logger.info({ jobId: job.id, data: job.data }, 'ping job consumed');
  },
  { connection },
);

// 下单成功邮件（#16② 真实 Job：enqueueOrderCreated → 此处消费 → 发邮件）
const orderCreatedWorker = new Worker<OrderCreatedJobData>(
  QUEUES.orderCreated,
  async (job) => {
    await processOrderCreated(job.data, { notify, idempotency });
  },
  { connection, concurrency: 4 },
);
orderCreatedWorker.on('completed', (job) =>
  logger.info({ jobId: job.id, uid: job.data.uid }, 'order-created 邮件已处理'),
);
orderCreatedWorker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, err: err?.message }, 'order-created 处理失败'),
);
workers.push(orderCreatedWorker);

// 启动前先连上 Redis（lazyConnect：不主动连，第一笔命令前才连，但 worker 要尽早暴露连接问题）
void waitForRedis(redis)
  .then(() =>
    logger.info(
      { queues: Object.values(QUEUES), defaultJobOptions: DEFAULT_JOB_OPTIONS },
      'worker up',
    ),
  )
  .catch((e) => {
    logger.error({ err: (e as Error).message }, 'worker 启动失败：Redis 不可达');
    process.exit(1);
  });
