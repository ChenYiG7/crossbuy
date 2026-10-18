import {
  adminLoginSchema,
  type AdminProfile,
  type AdminLoginInput,
  type AdminScope,
  type BusinessManagerEntry,
} from '@crossbuy/contract';
import { err, ok, type Result } from '@crossbuy/utils';
import type { AdminError } from './errors';
import type { AdminRepository } from './repository';
import type { AdminPasswordVerifier } from './password-verifier';

/**
 * 后台管理员/RBAC/操作日志 域服务（docs/04 §3.2：域间唯一调用面，R3 拆分的搬运单元）。
 *
 * - 出入参类型 = @crossbuy/contract（zod 契约），禁 ORM 类型泄漏到契约
 * - 只认 Principal（@crossbuy/auth 抽象），禁 Auth.js/Session 细节（docs/04 §6）
 * - 事务边界在 service；HTTP/推送/通知移出事务（AFTER_COMMIT 或事件后）
 * - 域间禁横向 import：跨域调用走对方 service 接口，跨域反应走 contract 事件
 * - 旧系统对应：app/Admin、Models/AdminUser、dcat-admin 权限表族（R1 零新表唯一例外）；R3 归属：独立后台基座
 *
 * M1 范围（docs/06 §四-4，只读起步）：login + scope 判定。写路径（memberid 编辑、
 * 重置密码等 Grid Action）随 admin 模块铺开，且遵守「PHP 唯一写方直到域绞杀」。
 */
export interface AdminService {
  /** 服务注册判别键（R3 服务注册表用） */
  readonly domain: 'admin';

  /**
   * 后台登录（旧 dcat AuthController 1:1）：
   * 用户名查找 → bcrypt 校验 → 软删拒登。**不区分**「不存在/错密码/已删除」——
   * 统一 ADMIN_INVALID_CREDENTIALS（旧 dcat 三者也同一句「用户名或密码错误」，禁枚举）。
   * 无登录限流（旧 dcat 默认无 throttle——差异点：member 端有 5 次/60s，admin 端没有）；
   * 若后续要加，须与旧系统同窗口对齐，禁单侧加锁造成灰度期行为分叉。
   */
  login(input: AdminLoginInput): Promise<Result<AdminProfile, AdminError>>;

  /**
   * 实时数据范围判定（旧 grid 每次渲染 `$user->cannot(...)` 的等价物，不进 token）。
   * 三分支语义见 contract adminScopeSchema 注释。
   */
  resolveScope(adminId: number): Promise<Result<AdminScope, AdminError>>;

  /** 名册（旧 getBusinessManagers）——列表页「客户代号」列展示用 */
  listBusinessManagers(): Promise<BusinessManagerEntry[]>;

  /** 后台操作者身份（chrome 回传：旧 `Admin::user()` 的 payid/username/name） */
  getIdentity(adminId: number): Promise<AdminIdentity | null>;
}

/** 后台操作者身份（chrome 插件回传链路的最小字段集） */
export interface AdminIdentity {
  id: number;
  username: string;
  name: string;
  /** 旧 `admin_users.payid`——采购员代号，回传时自动分配到订单 */
  payid: string;
}

export class AdminServiceImpl implements AdminService {
  readonly domain = 'admin' as const;

  constructor(
    protected readonly repository: AdminRepository,
    protected readonly passwordVerifier: AdminPasswordVerifier,
  ) {}

  async login(input: AdminLoginInput): Promise<Result<AdminProfile, AdminError>> {
    const parsed = adminLoginSchema.safeParse(input);
    if (!parsed.success) {
      return err({ code: 'ADMIN_INVALID_CREDENTIALS', message: '用户名或密码错误' });
    }

    const record = await this.repository.findAuthByUsername(parsed.data.username);
    // 不存在 / 软删 / 密码不符 → 同一错误（禁枚举；软删账号即使密码正确也走同一分支）
    if (!record || record.deleted) {
      return err({ code: 'ADMIN_INVALID_CREDENTIALS', message: '用户名或密码错误' });
    }
    if (!this.passwordVerifier.verify(parsed.data.password, record.password)) {
      return err({ code: 'ADMIN_INVALID_CREDENTIALS', message: '用户名或密码错误' });
    }

    const scope = await this.resolveScope(record.id);
    if (!scope.ok) return scope;

    const businessManagers = await this.repository.listBusinessManagers();
    return ok({
      id: record.id,
      username: record.username,
      name: record.name,
      scope: scope.value,
      businessManagers,
    } satisfies AdminProfile);
  }

  async resolveScope(adminId: number): Promise<Result<AdminScope, AdminError>> {
    if (!Number.isInteger(adminId) || adminId <= 0) {
      return err({ code: 'ADMIN_PRINCIPAL_INVALID', message: 'Principal 非法' });
    }

    if (await this.repository.canViewAllUsers(adminId)) {
      return ok({ kind: 'all' });
    }

    const record = await this.repository.findAuthById(adminId);
    if (!record || record.deleted) {
      return err({ code: 'ADMIN_NOT_FOUND', message: '管理员不存在' });
    }
    const flags = parseBusinessManagerFlags(record.businessManagerRaw);
    if (flags.length > 0) return ok({ kind: 'flags', flags });
    return ok({ kind: 'none' });
  }

  listBusinessManagers(): Promise<BusinessManagerEntry[]> {
    return this.repository.listBusinessManagers();
  }

  /**
   * 后台操作者身份（chrome 回传用：旧 `Admin::user()->payid/username/name`）。
   * 软删账号按「不存在」处理（旧 dcat SoftDeletingScope 查不到即 401）。
   */
  async getIdentity(adminId: number): Promise<AdminIdentity | null> {
    if (!Number.isInteger(adminId) || adminId <= 0) return null;
    const record = await this.repository.findChromeIdentity(adminId);
    if (!record || record.deleted) return null;
    return { id: record.id, username: record.username, name: record.name, payid: record.payid };
  }
}

/**
 * 旧模型 casts 'array' 的防御性解析：
 * `["G","I"]` → 数组；`[]` / `''` / NULL / 非法 JSON / 非数组 → 空数组
 * （PHP 侧 json_decode 失败返回 null，属性即 null，`empty()` 判真——等价空集）。
 */
function parseBusinessManagerFlags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}
