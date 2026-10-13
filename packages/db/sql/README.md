# packages/db/sql —— 迁移 SQL

本目录存放**手工可控**的迁移 SQL。生产旧库（`taotaro`）是**只读参考**：这里的脚本只写**新表**，绝不回写旧表。

## 文件与执行顺序

| # | 文件 | 用途 | 读写 | 阶段 |
|---|---|---|---|---|
| — | `precheck-username-duplicate.sql` | `dg_users.uname` 重名核查 | 只读 | 前置 |
| — | `disambiguate-username-proposal.sql` | 重名账号「保留/改名」建议 | 只读 | 前置 |
| ① | `0001-member-domain-up.sql` | 建 17 张新表（**由 schema.prisma 生成，勿手改**） | 建表 | T0 |
| ② | `0001a-member-username-collation.sql` | 把 `member.username` 排序规则定为 `utf8mb4_general_ci`（**手工 SQL**） | ALTER | T0 |
| ③ | `0002-member-backfill-t1.sql` | 回填 member 域**核心三表** + 顶 AUTO_INCREMENT（幂等） | 写新表 | T1 |
| ④ | `0003-member-backfill-verify.sql` | 核心三表 15 项一致性断言（必须全 PASS） | 只读 | T1 |
| ⑤ | `0004-member-backfill-t1-part2.sql` | 回填 **13 张侧表**（webhook/oauth/favorite/browse/benefit/log/area/PAT/idempotency） | 写新表 | T1 |
| ⑥ | `0005-member-backfill-verify-part2.sql` | 侧表行数 + 外键悬空 + id 保留断言 | 只读 | T1 |

> ✅ 全流程已在**本地 MySQL 9.7.2** 用「生产 DDL + 无 PII 合成样本」演练通过（核心三表 15/15 PASS；侧表 25 项全 PASS；3 遍幂等；回退验证 OK），见 `docs/plans/03-T1本地演练报告.md`。
>
> ⚠️ **生产写权限阻塞**：生产账号 `datapro` 仅有 `SELECT, INDEX, LOCK TABLES, SHOW VIEW`（`taotaro.*`），**无 CREATE/INSERT/ALTER/DROP**。①~⑤ 需由 DBA 用具备 DDL/DML 的账号执行。

## 第二批侧表回填要点（⑤ `0004`）

字段来源为**线上 `information_schema` 实测**（122 列 / 13 表），与目标 schema 逐列同名（仅 `uid → member_id`）。三个关键决策：

1. **过滤外键孤儿**：带 `member` 必需关系的表一律 `JOIN member`，只回填父行存在的记录（否则 Prisma `include` 会因关系缺失报错）。实测孤儿：`favorite` 240、`browse_history` 3389、`member_benefit` 3、`member_operation_log` 68；`oauth_login` 唯一一行（uid 21095）即孤儿 → 回填 0 行。
2. **PAT 取舍**：仅回填 `App\Models\User` 且父会员存在的 **105,808** 条；排除 539 条 `App\Models\AdminUser`（非会员域）+ 21 条父会员已不存在的 User token。Sanctum token 为 sha256 单向哈希（明文不可恢复）→ 保留 = 老客户端继续可用；**若 T2 改鉴权方案可整表清空重发**。
3. **保留源 id**：`favorite` / `browse_history` / `personal_access_token` 等大表 id 保留（含 id 空洞），跨系统对账可对齐；故末尾必须顶 `AUTO_INCREMENT`。

实测回填量（源 → 目标）：`benefit_config` 2→2 · `member_benefit` 718→715 · `member_operation_log` 3086→3018 · `personal_access_token` 106368→105808 · `oauth_login` 1→0 · `oauth_taobao_global` 1→1 · `favorite` 183753→183513 · `favorite_category` 20→20 · `browse_history` 210051→206662 · `area` 1940→1940 · `member_webhook`/`delivery`/`open_api_idempotency` 0→0。

## 0001 的来源与再生成

`0001-member-domain-up.sql` 从**正本** `prisma/schema.prisma` 生成，保证零漂移：

```bash
cd packages/db
DATABASE_URL="mysql://u:p@localhost:3306/db" \
  ../../node_modules/.bin/prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  > sql/0001-member-domain-up.sql
```

> ⚠️ **改 schema 后必须重新生成**，禁手改本文件。正本是 schema.prisma。
> `0001a` 是**例外**：Prisma 不支持列级 collation，故为手工 SQL，不属于「手改生成的 DDL」。

## 执行注意

1. **只对新表**：DDL 只建 `member*`、`favorite*`、`oauth_*`、`open_api_idempotency`、`browse_history`、`benefit*`、`area`、`ledger_entry`——全部新表名，**与旧库 174 张无重名**（已核查）。
2. **不改旧表**：对 `dg_users`/`dg_address`/`v2_*` **不做任何变更**。
3. **collation 必须先定（②）**：否则 `member.username` 会继承表级默认 `utf8mb4_unicode_ci`，重名口径从 8 组变 **24 组**，回填会失败（多出的 16 组含**不同人**）。详见 `docs/plans/03` §五。
4. **AUTO_INCREMENT 需顶高**（已内置于 ③）：回填后设为 `max(uid)+1`，否则新记录撞旧 id。注意 MySQL **不允许** `ALTER TABLE ... AUTO_INCREMENT = (子查询)`，脚本用 `PREPARE` 绕过。
5. **幂等**：③ 可反复执行（`INSERT ... SELECT ... ON DUPLICATE KEY UPDATE`）。旧库在回填期间仍在写入（实测 `dg_users` 22,611→22,612），必须可分批复跑。
6. **username 唯一约束的障碍在回填**：8 组 / 16 账号必须先消歧（③ 已内嵌映射）。
7. **不用 DB 端 `MD5()`**：本机 MySQL 9.7.2 无该函数；密码哈希由应用层（argon2）产生。

## 回退

全部为纯新增，回退 = `DROP` 新建的那批表即可，旧表与旧数据不受影响（本地已验证）。

## 相关文档

- `docs/plans/03-T1本地演练报告.md` —— 演练证据 + collation 决策 + 映射修正
- `docs/plans/02-用户名重名处置.md` —— Q4 查重结果（8 组 16 账号）+ 消歧规则
- `docs/plans/member-迁移与共存.md` —— 完整时序（T0→T3）/ 字段映射 / 验收 / 风险
- `docs/plans/member-schema.md` —— member 域设计
