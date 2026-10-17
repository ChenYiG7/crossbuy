import { loadConfig } from './config';
import { buildApp } from './app';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      app.log.info(`收到 ${signal}，优雅关闭…`);
      await app.close();
      process.exit(0);
    });
  }
}

void main();
