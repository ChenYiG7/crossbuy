import bcrypt from 'bcryptjs';

/**
 * 后台口令校验（旧 dcat-admin / Laravel `Hash::check` = **bcrypt**，$2y$ 前缀）。
 *
 * 与 member 域的 MD5 不同源——两套独立凭证体系，禁止共用校验器。
 * bcryptjs 纯 JS 实现（无原生编译依赖，Windows/CI 一致）；对 $2a/$2b/$2y 前缀
 * 均按同一算法处理（$2y$ 是 PHP crypt 的标记位，与 $2b$ 语义等价）。
 *
 * R2 切换点：若 admin 权限自用表族按红线允许升级（唯一可动表族），可换
 * argon2id——但旧列 80 字符且 PHP 侧同时在线读写，R1 一律原样 bcrypt。
 */
export interface AdminPasswordVerifier {
  verify(rawPassword: string, storedHash: string): boolean;
}

export class BcryptPasswordVerifier implements AdminPasswordVerifier {
  verify(rawPassword: string, storedHash: string): boolean {
    // bcryptjs 对非法哈希（空串/截断）抛错或恒 false——统一收敛为 false，
    // 登录分支不因存储异常而 500（1:1 旧 Hash::check 的 false 语义）
    try {
      return bcrypt.compareSync(rawPassword, storedHash);
    } catch {
      return false;
    }
  }
}
