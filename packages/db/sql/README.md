# packages/db/sql —— 迁移 SQL

本目录存放**手工可控**的迁移 SQL（不依赖 `prisma migrate` 直连旧库，避免误伤生产）。

## 文件

| 文件 | 用途 | 阶段 |
|---|---|---|
| `0001-member-domain-up.sql` | member 域 + finance `ledger_entry` 建表 DDL（**由 schema.prisma 生成，勿手改**） | T0 |
| `precheck-username-duplicate.sql` | `dg_users.uname` 重名核查（**只读**，Q4 前置） | 前置 |
| `disambiguate-username-proposal.sql` | 重名账号「保留/改名」建议（**只读**） | 前置 |

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

## T0 执行注意

1. **只对新表**：本 DDL 只 `CREATE TABLE member*`、`favorite*`、`oauth_*`、`open_api_idempotency`、`browse_history`、`benefit*`、`area`、`ledger_entry`——全部是新表名，**与旧库 174 张无重名**（已核查）。
2. **不改旧表**：T0 阶段对 `dg_users`/`dg_address`/`v2_*` **不做任何变更**。
3. **AUTO_INCREMENT 需在 T1 顶高**：建表时 `id` 从 1 开始；T1 回填（显式带 id）后必须
   `ALTER TABLE member AUTO_INCREMENT = <max(uid)+1>`，否则新记录会撞旧 id。
4. **username 唯一约束的前置**：建空表不受影响；但**T1 回填**会把 `dg_users.uname` 灌进 `member.username`（唯一列），**有重名即回填失败** → 回填前先跑 `precheck-username-duplicate.sql`。
   - **已跑（2026-10-13）**：旧库 22,611 用户中**8 组 / 16 个账号**重名（库排序规则 `utf8_general_ci`，ci + 尾部空格不敏感）。明细与消歧建议见 `docs/plans/02-用户名重名处置.md`，复现用 `disambiguate-username-proposal.sql`。
   - 除 1 个账号（uid 4109）外均零订单零余额 → 消歧须在 T1 回填中内嵌「按 uid 覆盖 username」映射。

## 回退

T0 是纯新增，回退 = `DROP TABLE` 新建的那批表即可，旧系统与旧数据不受影响。

## 相关文档

- `docs/plans/member-迁移与共存.md` —— 完整时序（T0→T3）/ 字段映射 / 验收 / 风险
- `docs/plans/member-schema.md` —— member 域设计
- `docs/plans/02-用户名重名处置.md` —— Q4 查重结果（8 组 16 账号）+ 消歧规则
