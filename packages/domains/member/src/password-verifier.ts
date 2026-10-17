import { createHash } from 'node:crypto';

/**
 * 口令校验端口（R1 = MD5 无盐 1:1 复现旧库 `dg_users.password CHAR(32)`）。
 *
 * ⚠ **R2 切换点**：argon2id 透明升级**无法在 R1 落地**——旧列只有 32 字符，
 * 容不下 ~97 字符的 argon2 哈希，而 R1「数据库不动」禁止建新表/加列
 * （docs/04）。升级随 R2 新表（member.passwordHash）一并落地，届时替换本实现即可，
 * 登录流程零改动。旧系统侧同一约束见 docs/plans/member-schema.md §密码。
 */
export interface PasswordVerifier {
  /** 校验原始口令；storedHash 为库中存储的哈希串 */
  verify(rawPassword: string, storedHash: string): boolean;
}

/**
 * MD5 无盐校验（旧系统 `md5($password)` 语义）：
 * - 产出小写 hex；比对时两侧都转小写——旧库列 collation（utf8_general_ci）
 *   使 MySQL 侧比对本就大小写不敏感，这里保持同样行为
 * - trim() 防御 CHAR 列取值的尾部空白
 */
export class Md5PasswordVerifier implements PasswordVerifier {
  verify(rawPassword: string, storedHash: string): boolean {
    const digest = createHash('md5').update(rawPassword, 'utf8').digest('hex');
    return digest === storedHash.trim().toLowerCase();
  }
}
