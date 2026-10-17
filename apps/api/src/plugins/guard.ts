import { createHmac, timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { envelopeFail } from '../envelope';
import { parseList, type ApiConfig } from '../config';

/**
 * 开放 API 面守卫：IP 白名单 + HMAC 签名（docs/04 §4-6：旧开放面语义平移，
 * 外部调用方零感知；docs/04 §4-5：401 = 未登录/签名无效，503 = 鉴权不可用，不 302）。
 *
 * 卫生要点：
 * - 时间戳窗口（默认 300s）防重放；签名用 **timingSafeEqual** 防时序攻击
 * - production 缺密钥 ⇒ **503 拒绝**（不是放行）；仅 dev 允许无密钥调试
 * - 健康检查 / 文档路由豁免（否则外部探活会被签名拦住）
 */

/** IPv4 → uint32（兼容 ::ffff: 映射形式） */
function ipToInt(ip: string): number {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return v4.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** 支持精确 IP 与 CIDR（IPv4） */
export function ipAllowed(ip: string, rules: string[]): boolean {
  if (rules.length === 0) return true; // 未配置 = 不限制
  return rules.some((rule) => {
    if (!rule.includes('/')) return rule === ip || rule === ip.replace('::ffff:', '');
    const parts = rule.split('/');
    const base = parts[0];
    const bitsRaw = parts[1];
    if (base === undefined || bitsRaw === undefined) return false;
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = ~(2 ** (32 - bits) - 1) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
  });
}

export function verifyHmac(
  secret: string,
  payload: string,
  signature: string,
): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface GuardOptions {
  config: ApiConfig;
  /** 豁免路径（精确匹配 url）：健康检查、文档 */
  exempt?: string[];
}

// ⚠ 必须 fp 包装：不用 fp 的话，插件内 addHook 只作用于**它自己内部**注册的路由，
// 而业务路由是注册在同级 scope 上的兄弟 ⇒ 守卫形同虚设。
// （首跑实测：无签名/错签名/白名单外 IP 全部 200，6 项守卫断言全 FAIL 才暴露。）
export const guardPlugin = fp(async (
  app: FastifyInstance,
  opts: GuardOptions,
): Promise<void> => {
  const { config } = opts;
  const exempt = opts.exempt ?? [];
  const allowRules = parseList(config.API_OPEN_IP_ALLOWLIST);

  if (config.NODE_ENV === 'production') {
    if (!config.API_OPEN_HMAC_SECRET) {
      app.log.warn('[guard] production 未配置 API_OPEN_HMAC_SECRET ⇒ 开放面将 503');
    }
    if (allowRules.length === 0) {
      app.log.warn('[guard] production 未配置 IP 白名单 ⇒ 开放面对全网开放');
    }
  }

  // ① IP 白名单（onRequest：最早拒绝，不浪费后续解析）
  app.addHook('onRequest', async (req, reply) => {
    if (exempt.includes(req.routeOptions?.url ?? req.url)) return;
    if (!ipAllowed(req.ip, allowRules)) {
      return reply
        .code(403)
        .send(envelopeFail(403, 'IP not allowed', req.traceId));
    }
  });

  // ② HMAC 签名（preHandler：此时 body 已解析，可参与签名）
  app.addHook('preHandler', async (req, reply) => {
    if (exempt.includes(req.routeOptions?.url ?? req.url)) return;

    const secret = config.API_OPEN_HMAC_SECRET;
    if (!secret) {
      if (config.NODE_ENV === 'production') {
        // 鉴权不可用 ≠ 放行（docs/04 §4-5 的 503 语义）
        return reply
          .code(503)
          .send(envelopeFail(503, 'auth unavailable', req.traceId));
      }
      app.log.warn('[guard] dev 模式无签名密钥，跳过签名校验');
      return;
    }

    const ts = req.headers['x-timestamp'];
    const sig = req.headers['x-signature'];
    if (typeof ts !== 'string' || typeof sig !== 'string') {
      return reply
        .code(401)
        .send(envelopeFail(401, 'missing signature headers', req.traceId));
    }

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      return reply.code(401).send(envelopeFail(401, 'bad timestamp', req.traceId));
    }
    const skew = Math.abs(Date.now() / 1000 - tsNum);
    if (skew > config.API_OPEN_TS_TOLERANCE_SEC) {
      return reply
        .code(401)
        .send(envelopeFail(401, 'timestamp out of window', req.traceId));
    }

    const body = req.body === undefined ? '' : JSON.stringify(req.body);
    const payload = `${ts}\n${req.method}\n${req.routeOptions?.url ?? req.url}\n${body}`;
    if (!verifyHmac(secret, payload, sig)) {
      return reply.code(401).send(envelopeFail(401, 'invalid signature', req.traceId));
    }
  });
});
