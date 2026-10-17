import { legacyPrisma } from '@crossbuy/db';

/**
 * 事务回滚助手（M0.9 基线，edit-user-info.spec.ts 提取为共享）：
 * 结果带出来，改动全部丢弃——dump 库不能被测试写脏。
 *
 * 用法注意：**造数据与断言必须在同一个 withRollback 里**（事务外看不到未提交行，
 * 回滚后也不存在了）。登录类用例的「改库副作用」断言同样要在事务内读。
 */
class Rollback extends Error {}

export async function withRollback<T>(fn: (tx: typeof legacyPrisma) => Promise<T>): Promise<T> {
  let result: T;
  try {
    await legacyPrisma.$transaction(async (tx) => {
      result = await fn(tx as typeof legacyPrisma);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return result!;
}
