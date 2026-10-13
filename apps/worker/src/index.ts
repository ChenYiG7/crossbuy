import { parseEnv } from '@crossbuy/config';
import { Queue, Worker } from 'bullmq';
import pino from 'pino';
import { QUEUES, createConnection } from './queues';

const env = parseEnv();
const logger = pino({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' });
const connection = createConnection(env.REDIS_URL);

// 队列 + 消费者装配点：后续每个业务域在此注册自己的 Queue + Worker + 定时任务。
// 铁律：所有消费必须幂等（1688 webhook 会重复投递，见 docs/07 守则）。
const pingQueue = new Queue(QUEUES.ping, { connection });

new Worker(
  QUEUES.ping,
  async (job) => {
    logger.info({ jobId: job.id, data: job.data }, 'ping job consumed');
  },
  { connection },
);

logger.info({ queues: Object.values(QUEUES) }, 'worker up');
