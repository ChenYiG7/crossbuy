// M0.5：旧表 → 域属主归类（docs/06 任务 0.5）。
//
// 为什么写成脚本而不是手抄 179 行：① 规则集中、可审计、可重跑（生产复跑 pull 后
// 新增表会立刻暴露为「未归类」，不会静默漏掉）；② 统计与「待裁决清单」自动产出，
// 人工只需裁决 low 置信度那部分；③ 与 post-pull-fixup.mjs 同样的「标记区间覆写」
// 模式，文档正文手写、机器产出分区，互不冲掉。
//
// 用法：node scripts/classify-table-owners.mjs [--check]
//   --check  = 只体检不写文档（未归类必须为 0，否则 exit 1）

import { readFileSync, writeFileSync } from 'node:fs';

const SCHEMA = 'packages/db/prisma/schema.prisma';
const DOC = 'docs/plans/07-表属主映射.md';
const BEGIN = '<!-- BEGIN AUTO MAPPING -->';
const END = '<!-- END AUTO MAPPING -->';
const CHECK_ONLY = process.argv.includes('--check');

// 生产视图（Prisma 不建模，但要用就得有属主）
const VIEWS = [
  {
    name: 'dg_mail1',
    domain: 'notify',
    conf: 'mid',
    reason: '生产中是视图（无 Prisma 模型，只能 raw SQL）；与 dg_mail 同族',
  },
];

// ---- 归类规则（顺序敏感：先具体后兜底）----
// conf: high = 已拍板/语义明确；mid = 语义基本明确但需复核；low = 待人工裁决
// reason 必须写清「为什么归这个域」，否则等于没裁决
const RULES = [
  // ===== 已定映射（docs/plans/07 §二 原有，置信度最高）=====
  {
    re: /^dg_users(_cache)?$/,
    domain: 'member',
    conf: 'high',
    reason: '会员主表（v2_ 无会员主表，实锤）+ 会员缓存',
  },
  {
    re: /^dg_record(_old)?$/,
    domain: 'finance',
    conf: 'high',
    reason: '余额流水（已定；分录 id 新分配靠 (legacy_source,legacy_id) 对齐）',
  },
  {
    re: /^dg_rechargerecord$/,
    domain: 'finance',
    conf: 'high',
    reason: '入金单（已定；amount 是 JPY，别与对客 CNY 口径混）',
  },
  { re: /^dg_huilv$/, domain: 'finance', conf: 'high', reason: '汇率（已定）' },
  {
    re: /^finance_order_cash_flow$/,
    domain: 'finance',
    conf: 'high',
    reason: '财务代付动作流水（已定；不含服务费）',
  },
  {
    re: /^v2_worldfirst_/,
    domain: 'finance',
    conf: 'high',
    reason: 'WorldFirst 对账族（已定；生产实为 0 行空壳）',
  },
  {
    re: /^(v2_address|v2_area|dg_area)$/,
    domain: 'member',
    conf: 'high',
    reason: '行政区划字典（已定；**不是收货地址**）',
  },
  {
    re: /^(dg_sendorder|dg_send|dg_baoguo|dg_fapiao|dg_delivery|v2_send_order_)/,
    domain: 'send-order',
    conf: 'high',
    reason: '运单/包裹/发货/配送/发票（已定：发票归 send-order）',
  },

  // ===== member =====
  { re: /^(dg_address|dg_gdaddress)$/, domain: 'member', conf: 'high', reason: '会员收货地址' },
  {
    re: /^(dg_favorite|v2_favorite|v2_favorite_category)$/,
    domain: 'member',
    conf: 'high',
    reason: '会员收藏夹/收藏分类',
  },
  { re: /^v2_user_browse_history$/, domain: 'member', conf: 'high', reason: '会员浏览历史' },
  { re: /^v2_oauth_login$/, domain: 'member', conf: 'high', reason: '会员第三方登录绑定' },
  {
    re: /^v2_personal_access_tokens$/,
    domain: 'member',
    conf: 'high',
    reason: 'PAT 令牌（TODO #3e 已列 member 侧）',
  },
  // 注意词形：实际表名是 user_benefits + user_benefit_configs（后者是**单数** benefit）
  {
    re: /^user_benefits?(_configs)?$/,
    domain: 'member',
    conf: 'high',
    reason: '会员权益及配置（TODO #3e 已列 member 侧）',
  },
  {
    re: /^user_operation_log$/,
    domain: 'member',
    conf: 'mid',
    reason: '会员操作日志（按「谁的用户谁拥有」；若后续证明是后台审计则改 admin）',
  },
  {
    re: /^dg_scorerecord$/,
    domain: 'member',
    conf: 'mid',
    reason: '积分记录（积分是会员资产，非资金；若与余额互转则需 finance 出裁决）',
  },

  // ===== order =====
  { re: /^dg_order(_split)?$/, domain: 'order', conf: 'high', reason: '订单主表 / 拆单' },
  { re: /^dg_cart(_copy1)?$/, domain: 'order', conf: 'high', reason: '购物车（copy1 同族）' },
  { re: /^dg_imporder(_detail)?$/, domain: 'order', conf: 'high', reason: '导入订单及明细' },
  { re: /^dg_invalid_order$/, domain: 'order', conf: 'high', reason: '无效订单' },
  {
    re: /^dg_bargain_record$/,
    domain: 'order',
    conf: 'high',
    reason: '砍价记录（bargainprice 语义 Order/SendOrder 不同，属主在 order）',
  },
  {
    re: /^(dg_coupon|dg_discount)$/,
    domain: 'order',
    conf: 'mid',
    reason: '优惠券/折扣（挂在订单上的营销属性；若后续做独立营销域再拆）',
  },
  {
    re: /^v2_order_(auto_created|client_ref|detail)$/,
    domain: 'order',
    conf: 'high',
    reason: '订单扩展（自动建单/客户端引用/明细）',
  },
  {
    re: /^relation_order_and_operation_record$/,
    domain: 'order',
    conf: 'high',
    reason: '订单-操作记录关联（谁写谁拥有：订单侧写）',
  },
  {
    re: /^dg_examination_record$/,
    domain: 'order',
    conf: 'low',
    reason: '⚠ 查验记录——order(下单查验) vs send-order(仓库验货) 边界模糊，需按业务确认',
  },
  {
    re: /^relation_order_and_examination_record$/,
    domain: 'order',
    conf: 'low',
    reason: '⚠ 随 dg_examination_record 的裁决结果联动（不能与它分家）',
  },
  { re: /^dg_otype$/, domain: 'order', conf: 'high', reason: '订单类型字典（随 order 域）' },

  // ===== purchase =====
  {
    re: /^v2_supplier_(product|product_sku|shop)$/,
    domain: 'purchase',
    conf: 'high',
    reason: '供应商商品/店铺（采购源数据）',
  },
  {
    re: /^t_purchase_schedule(s)?(_assignments)?$/,
    domain: 'purchase',
    conf: 'high',
    reason: '采购排期及分配',
  },
  {
    re: /^(dg_goods|dg_goodstype|dg_gtype)$/,
    domain: 'purchase',
    conf: 'mid',
    reason: '商品库/商品类型（采购申报的商品；若证明是前台展示商品则改 content）',
  },
  {
    re: /^dg_caizhi$/,
    domain: 'purchase',
    conf: 'low',
    reason: '⚠ 材质字典——归属取决于它是采购申报属性还是商品展示属性，需确认',
  },
  // ★ 改判：一度按字面归 platform，但 docs/plans/01 §1.9 写明它是「平台**采买**子账号」
  //   （appid/token/taobao_global|alibaba）= 采买账号池 ⇒ 归 purchase。
  //   注意与 member-schema.md「待 order 域再定」存在分歧，故置信度仍为 low。
  {
    re: /^v2_platform_sub_account$/,
    domain: 'purchase',
    conf: 'low',
    reason:
      '⚠ 采买子账号池（01 §1.9）——底稿 member-schema 却写「待 order 域再定」，两处结论分歧需裁决',
  },

  // ===== logistics =====
  {
    re: /^(dg_airbill|dg_airbillprice|dg_yunjiao)$/,
    domain: 'logistics',
    conf: 'high',
    reason: '运单（airbill）/运价/运费价格',
  },
  { re: /^v2_logistic_domestic$/, domain: 'logistics', conf: 'high', reason: '国内物流' },
  // 词形：v2_freight_calculators（复数）与 v2_freight_calculator_category（**单数**）
  {
    re: /^v2_freight_calculators?(_category)?$/,
    domain: 'logistics',
    conf: 'high',
    reason: '运费计算器及分类',
  },
  {
    re: /^v2_relation_order_and_logistic_domestic(_old)?$/,
    domain: 'logistics',
    conf: 'mid',
    reason: '订单-国内物流关联（物流侧写）',
  },

  // ===== platform =====
  {
    re: /^v2_ecommerce_/,
    domain: 'platform',
    conf: 'high',
    reason: '外部电商平台订单/商品/SKU/店铺（已定：currency 是平台自身结算币种）',
  },
  {
    re: /^v2_platform_order_amount$/,
    domain: 'platform',
    conf: 'high',
    reason: '平台侧金额快照（子账号已改判归 purchase，见上）',
  },
  // 用户平台账号：uid + platform(1688/taobao) + submit_info(JSON 下单提交信息) ⇒ 下单链路用
  {
    re: /^v2_user_platform_account$/,
    domain: 'order',
    conf: 'low',
    reason:
      '⚠ 用户平台账号（01 §1.8：uid+platform+submit_info=下单提交信息）——底稿说与 order 耦合、「待 order 域再定」（member-schema Q6）',
  },
  {
    re: /^dg_trandata$/,
    domain: 'platform',
    conf: 'low',
    reason:
      '⚠ 底稿无记录，本次生产凭据不可用**未能查证列结构**；字面疑为翻译/交易数据，暂归 platform 待人工确认',
  },
  {
    re: /^v2_relation_ecommerce_product_sku_and_/,
    domain: 'platform',
    conf: 'mid',
    reason: '平台 SKU 与订单/供应商 SKU 的映射（平台侧写）',
  },
  {
    re: /^(dg_shop_goods|dg_shop_gtype|dg_shopsite|dg_stores)$/,
    domain: 'platform',
    conf: 'mid',
    reason: '外部店铺商品/站点（对接外部平台）',
  },
  { re: /^v2_ai_task$/, domain: 'platform', conf: 'high', reason: 'AI 任务（外部平台能力）' },
  {
    re: /^(v2_oauth_taobao_global|dg_taobao_fycache)$/,
    domain: 'platform',
    conf: 'mid',
    reason: '淘宝 OAuth / 翻译缓存（平台对接；若只服务会员登录则改 member）',
  },
  {
    re: /^dg_holidays$/,
    domain: 'platform',
    conf: 'mid',
    reason: '节假日字典（影响平台履约时效；非会员资产）',
  },

  // ===== finance =====
  {
    re: /^(dg_bankaccount|dg_payid|dg_pm)$/,
    domain: 'finance',
    conf: 'mid',
    reason: '银行账户/支付单号/支付方式（资金侧；dg_pm 需确认是支付方式字典）',
  },
  { re: /^dg_refund$/, domain: 'finance', conf: 'high', reason: '退款' },
  {
    re: /^relation_order_and_finance_order_cash_flow$/,
    domain: 'finance',
    conf: 'high',
    reason: '订单-代付流水关联（财务侧写）',
  },
  {
    re: /^relation_bill_and_model$/,
    domain: 'finance',
    conf: 'low',
    reason: '⚠ 账单-模型关联——bill 是运单账单还是财务账单未确认，需在 send-order/finance 间裁决',
  },

  // ===== ticket =====
  { re: /^v2_ticket(_activity)?$/, domain: 'ticket', conf: 'high', reason: '工单及工单动态' },
  {
    re: /^dg_inquiry_order(_item)?$/,
    domain: 'ticket',
    conf: 'high',
    reason: '询价单及明细（生产仅 23 行）',
  },
  {
    re: /^dg_service$/,
    domain: 'ticket',
    conf: 'mid',
    reason: '客服/服务单（工单域；若证明是售后则归 order）',
  },

  // ===== content =====
  {
    re: /^(dg_article|dg_atype|dg_news|dg_about)$/,
    domain: 'content',
    conf: 'high',
    reason: '文章/类型/新闻/关于我们（CMS）',
  },
  {
    re: /^v2_(article_category|blog|blog_category|blog_tag|blog_tag_relation)$/,
    domain: 'content',
    conf: 'high',
    reason: '博客与文章分类/标签（CMS）',
  },
  {
    re: /^dg_guestbook$/,
    domain: 'content',
    conf: 'mid',
    reason: '留言板（内容侧；若走客服工单流程则改 ticket）',
  },
  {
    re: /^(dg_special|dg_useful|v2_calendar)$/,
    domain: 'content',
    conf: 'mid',
    reason: '专题/实用信息/日历（内容运营）',
  },
  {
    re: /^dg_warnkeyword$/,
    domain: 'content',
    conf: 'mid',
    reason: '敏感词（内容风控；若用于平台商品风控则改 platform）',
  },

  // ===== openapi =====
  {
    re: /^v2_open_api_idempotency$/,
    domain: 'openapi',
    conf: 'high',
    reason: '开放 API 幂等键（新系统幂等纪律的对应物）',
  },
  {
    re: /^v2_member_webhook(_delivery)?$/,
    domain: 'openapi',
    conf: 'mid',
    reason: '会员 webhook 订阅与投递（生产 0 行；openapi 面，member 域只读其结果）',
  },

  // ===== wms-gateway =====
  {
    re: /^dg_shel(f|ves)(_detail|_sub|_users)?$/,
    domain: 'wms-gateway',
    conf: 'mid',
    reason: '货架/库位（仓储侧；WMS 独立项目后经 gateway 对接）',
  },

  // ===== notify（基础设施，非业务域）=====
  {
    re: /^(dg_mail|dg_smtpaccount|email_task_record)$/,
    domain: 'notify',
    conf: 'high',
    reason: '邮件与 SMTP 账号/邮件任务记录（通知渠道）',
  },
  { re: /^oa_notify(_record)?$/, domain: 'notify', conf: 'high', reason: 'OA 通知及发送记录' },

  // ===== admin（后台基础设施，非业务域）=====
  // ⚠ 特殊规则必须在通用 admin_ 前缀规则**之前**，否则会被泛泛理由吃掉
  //   （admin_operation_log 是亿级表，这条约束很重要，不能显示成普通的 RBAC 表）
  {
    re: /^admin_operation_log$/,
    domain: 'admin',
    conf: 'high',
    reason: '后台操作日志（**亿级**；新后台异步 + 分区归档，不照搬直写）',
  },
  {
    re: /^(admin_|sys_|system_setting$)/,
    domain: 'admin',
    conf: 'high',
    reason: '后台 RBAC/菜单/权限/字典/文件/任务/系统设置',
  },
  {
    re: /^dg_(admin|adminmange|admin_operation_log)$/,
    domain: 'admin',
    conf: 'high',
    reason: '后台管理员与后台操作日志（旧后台表，非 admin_operation_log 亿级表）',
  },
  { re: /^dg_sysconfig$/, domain: 'admin', conf: 'high', reason: '系统配置' },
  { re: /^dg_ipfilter(ing)?$/, domain: 'admin', conf: 'high', reason: '后台 IP 白/黑名单' },

  // ===== 冻结 / 待清理 =====
  {
    re: /^deprecated_/,
    domain: 'deprecated',
    conf: 'high',
    reason: '已废弃副本（21 张）：域代码**不许碰**，R2 清理；入模只为忠实快照',
  },
  {
    re: /^failed_jobs$/,
    domain: 'infra',
    conf: 'high',
    reason: '队列失败任务（Laravel 基础设施；新系统由 worker 兜底重试，不归业务域）',
  },
  {
    re: /^v2_statistics$/,
    domain: 'infra',
    conf: 'low',
    reason: '⚠ 统计报表——归报表(infra) 还是业务域（platform/finance）需确认',
  },
  {
    re: /^dg_ceshi$/,
    domain: 'infra',
    conf: 'low',
    reason: '⚠ 字面为「测试」表，疑为遗留测试残留；确认无用后随 R2 清理',
  },
];

// ---- 读取生产表清单（权威源 = introspect 产物）----
function readTables() {
  const src = readFileSync(SCHEMA, 'utf8');
  const models = [...src.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{/gm)].map((m) => m[1]);
  if (models.length === 0)
    throw new Error(`未从 ${SCHEMA} 解析到任何模型，schema 是否已被 pull 冲掉？`);
  return models.sort();
}

// 记录每条规则的命中数 —— 零命中 = 规则被前面的规则遮蔽（或正则写错）而静默失效。
// 教训：admin_operation_log 的专门理由曾被通用 admin_ 前缀规则吃掉，靠这个检测才能发现。
const hitCount = new Array(RULES.length).fill(0);

function classify(name) {
  for (let i = 0; i < RULES.length; i++) {
    if (RULES[i].re.test(name)) {
      hitCount[i]++;
      return RULES[i];
    }
  }
  return null;
}

function main() {
  const tables = readTables();
  const rows = [
    ...tables.map((name) => ({
      name,
      kind: '',
      ...(classify(name) || { domain: '❌未归类', conf: 'low', reason: '没有任何规则命中' }),
    })),
    ...VIEWS.map((v) => ({
      name: v.name,
      kind: '视图',
      domain: v.domain,
      conf: v.conf,
      reason: v.reason,
    })),
  ];

  const unclassified = rows.filter((r) => r.domain === '❌未归类');
  const low = rows.filter((r) => r.conf === 'low' && r.domain !== '❌未归类');

  // 守卫：零命中的规则（被遮蔽 / 写错）—— 静默失效比报错更危险
  const deadRules = RULES.map((r, i) => ({ r, i })).filter(({ r: _r, i }) => hitCount[i] === 0);
  if (deadRules.length > 0) {
    console.warn(`\n[warn] ${deadRules.length} 条规则零命中（可能被前面的规则遮蔽）：`);
    for (const { r } of deadRules)
      console.warn(`  - ${r.re} → ${r.domain} | ${r.reason.slice(0, 40)}...`);
    console.warn('');
  }

  // 统计（按域）
  const byDomain = new Map();
  for (const r of rows) byDomain.set(r.domain, (byDomain.get(r.domain) ?? 0) + 1);
  const domainOrder = [...byDomain.entries()].sort((a, b) => b[1] - a[1]);

  // ---- 生成 markdown ----
  const L = [];
  L.push('> 本节由 `scripts/classify-table-owners.mjs` 自动生成（改规则改脚本，勿手改本节）。');
  L.push(
    `> 数据源 = \`packages/db/prisma/schema.prisma\`（生产 179 模型）+ 1 张生产视图。**共 ${rows.length} 个对象**。`,
  );
  L.push('');
  L.push('### 分布');
  L.push('');
  L.push('| 域 | 对象数 | 说明 |');
  L.push('|---|---|---|');
  const DOMAIN_NOTE = {
    member: '会员资产',
    order: '订单（购物车/砍价/拆单）',
    purchase: '采购与供应商',
    'send-order': '运单/包裹/发票',
    logistics: '物流与运费',
    platform: '外部平台对接',
    finance: '资金（流水/充值/汇率/对账）',
    ticket: '工单与询价',
    content: 'CMS 内容',
    openapi: '开放 API 与 webhook',
    'wms-gateway': '仓储对接（未来独立 WMS）',
    notify: '通知渠道（基础设施，非业务域）',
    admin: '后台 RBAC/配置（基础设施，非业务域）',
    infra: '队列/统计等基础设施',
    deprecated: '**已废弃，域代码禁止访问，R2 清理**',
  };
  for (const [d, n] of domainOrder) {
    L.push(`| \`${d}\` | ${n} | ${DOMAIN_NOTE[d] ?? ''} |`);
  }
  L.push('');
  L.push('### 逐张映射');
  L.push('');
  for (const [d] of domainOrder) {
    const list = rows.filter((r) => r.domain === d);
    L.push(`**\`${d}\`（${list.length}）**`);
    L.push('');
    L.push('| 对象 | 置信 | 依据 |');
    L.push('|---|---|---|');
    for (const r of list) {
      L.push(`| \`${r.name}\`${r.kind ? `（${r.kind}）` : ''} | ${r.conf} | ${r.reason} |`);
    }
    L.push('');
  }
  if (low.length > 0) {
    L.push('### ⚠ 待人工裁决（low 置信）');
    L.push('');
    L.push(
      '规则里的「每张表唯一属主 + 不许留共享表」要求这些必须有结论。逐张确认后**改脚本规则**（不是改本节）。',
    );
    L.push('');
    for (const r of low) L.push(`- \`${r.name}\` — ${r.reason}`);
    L.push('');
  }

  const body = L.join('\n');

  if (CHECK_ONLY) {
    console.log(
      `[check] ${rows.length} 个对象；未归类 ${unclassified.length}；待裁决 ${low.length}`,
    );
    for (const [d, n] of domainOrder) process.stdout.write(`  ${d}: ${n}\n`);
    if (unclassified.length > 0) {
      console.error('\n未归类（新表？）：');
      for (const r of unclassified) console.error('  -', r.name);
      process.exit(1);
    }
    console.log('\n[check] PASS 无未归类对象');
    return;
  }

  // ---- 写回文档（标记区间覆写，幂等）----
  const doc = readFileSync(DOC, 'utf8');
  const b = doc.indexOf(BEGIN);
  const e = doc.indexOf(END);
  if (b === -1 || e === -1) {
    throw new Error(`文档缺少标记区间（${BEGIN} / ${END}），先在 docs/plans/07 里手工放好这对标记`);
  }
  const next = doc.slice(0, b) + BEGIN + '\n\n' + body + '\n' + END + doc.slice(e + END.length);
  writeFileSync(DOC, next, 'utf8');

  console.log(
    `[classify] ${rows.length} 个对象 → ${domainOrder.length} 个域；未归类 ${unclassified.length}；待裁决 ${low.length}`,
  );
  if (unclassified.length > 0) {
    console.error('未归类：');
    for (const r of unclassified) console.error('  -', r.name);
    process.exit(1);
  }
}

main();
