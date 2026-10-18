/**
 * 头像存储怪癖的 1:1 复现（旧系统 haiou，只读参考）：
 *
 * **写侧**（旧 `EditUserInfoMutation::resolve`）：
 *   `$args['face'] = str_replace(ossFullHost(), '', $args['face'])`
 *   ossFullHost() = `https://{OSS_BUCKET}.{OSS_INTERNAL_ENDPOINT 去掉 https://}`
 *   （Helpers.php:593）——客户端传完整 URL，入库只存相对 key。
 *
 * **读侧**（旧 `UserInfoType::resolveAvatarField`）：
 *   face 以 `/user/avatar` 或 `/avatar` 开头 → 返回 `OSS_CDN_URL + face`，否则原样返回。
 *
 * 实测 dump 数据印证两种形态并存：有存相对 key 的（/user/avatar/2024/...），
 * 也有存完整 URL 的（taotaro-hz.oss-accelerate.aliyuncs.com/...——accelerate 域名
 * 不在剥离名单里，旧系统照存不误，1:1 复现不「顺手修」）。
 *
 * 该怪癖已登记 docs/plans/08（S10）；R2 收敛为「统一存 key + 显式 URL 生成器」。
 */

/** 读侧判定前缀（旧 resolveAvatarField 字面量） */
const AVATAR_KEY_PREFIXES = ['/user/avatar', '/avatar'] as const;

/**
 * 读侧：相对 key → CDN 完整 URL（旧 resolveAvatarField）。
 * cdnUrl 为空（未配置）时原样返回——开发期不配 OSS_CDN_URL 也能看库里的原值。
 */
export function resolveAvatarUrl(face: string | null, cdnUrl: string): string | null {
  if (!face) return null;
  if (cdnUrl && AVATAR_KEY_PREFIXES.some((prefix) => face.startsWith(prefix))) {
    return cdnUrl + face;
  }
  return face;
}

/**
 * 写侧：剥离 ossFullHost 前缀（旧 EditUserInfoMutation）。
 * ossFullHost 为空（未配置）时原样返回——禁把「没配环境变量」静默变成「改数据」。
 */
export function stripOssFullHost(url: string, ossFullHost: string): string {
  if (!ossFullHost) return url;
  return url.startsWith(ossFullHost) ? url.slice(ossFullHost.length) : url;
}

/**
 * 旧 Helpers.php:593 的 ossFullHost() 推导：
 * `str_replace('https://', 'https://' . OSS_BUCKET . '.', OSS_INTERNAL_ENDPOINT)`
 * ——把 bucket 插进内部端点的域名前缀。缺任一env返回空串（= 不剥离）。
 */
export function deriveOssFullHost(
  bucket: string | undefined,
  internalEndpoint: string | undefined,
): string {
  if (!bucket || !internalEndpoint) return '';
  return internalEndpoint.replace('https://', `https://${bucket}.`);
}
