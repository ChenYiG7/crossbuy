# 部署管线（M0.8，docs/04 §2 D3）

> **仓库 ≠ 部署单元**：五 app = 五独立部署单元。改一个后台页面 → 只构建发布 admin，
> web/mzk 线上进程零感知（turbo 缓存保证其余 app 不重建）。

## 组装发布目录（本机）

```bash
node scripts/deploy.mjs web      # 产物 → releases/web/<ts>-<sha>/
node scripts/deploy.mjs api
node scripts/deploy.mjs --list   # 查看已有产物
```

- Next app（web/mzk/admin）：standalone 产物 + `.next/static` + `public` 叠加，
  入口 `node apps/<app>/server.js`（目录结构与 monorepo 相对路径一致）。
- Node app（api/worker）：`pnpm deploy --prod` 打平生产依赖（workspace 包为打包副本），
  入口 `node dist/index.js`。
- 每个发布目录带 `MANIFEST.json`（app / releaseId / gitSha / builtAt）——回滚审计的依据。

## 发布影响半径（发版前必跑）

```bash
node scripts/blast-radius.mjs              # 未提交改动
node scripts/blast-radius.mjs main         # main...HEAD
```

分级规则（与 docs/04 D3 表一一对应）：

| 改动                                   | 需发布                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `apps/<a>/**`                          | 只有该 app                                                                |
| `packages/<p>/**`（ui/db/utils…）      | 反向依赖它的 app，各自择机发                                              |
| `packages/domains/<d>/**` 或契约域文件 | 该域**全部写方**同窗口协同发（`deploy/blast-radius.config.mjs` 登记清单） |
| docs / scripts / deploy / `*.md`       | 无需发版                                                                  |

**版本偏斜纪律**：域写路径变更后未协同发布的写方进程仍跑旧代码写同一张表——
靠分级发布纪律管住，不靠全量重发；契约向后兼容（只加字段不改语义）时可省协同。

## 服务器侧流程（rsync + 蓝绿切换）

1. 本机组装 → `rsync -a releases/<app>/<id>/ deploy@<host>:/srv/crossbuy/<app>/<id>/`
2. 启动新色进程（PORT = 该色的端口，见模板头注释）：systemd unit 模板按 app+色 实例化
3. 冒烟通过后切换（**秒级，不重新构建、不重启旧色**）：

```bash
echo 'proxy_pass http://web_green;' > /etc/nginx/upstreams/web-active.conf
nginx -t && nginx -s reload        # 只 reload，绝不 restart（运维纪律）
```

4. 回滚 = 把 active.conf 指回旧色再 reload；旧色目录保留至下一次发布完成后清理
5. 观察期（≥2 周灰度）：旧色进程保持运行，日志双份可对照

## 尚未自动化（后续增量）

- systemd unit 模板与远端发布脚本（等 staging 机器定下来；凭据只走环境变量）
- pino → SLS 传输（transport 配置位已留，apps/api 已带 traceId）
- CI 集成（blast-radius 作为 PR check 输出「需发布清单」评论）
