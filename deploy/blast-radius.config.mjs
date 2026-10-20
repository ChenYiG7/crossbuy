/**
 * 发布影响半径（blast radius）判定配置 —— docs/04 §2 D3 的机器可读版。
 *
 * 域写路径变更 → 该域**全部写方进程**同窗口协同发（版本偏斜纪律：未协同发布的
 * 写方进程仍跑旧代码写同一张表）。清单必须**保守**（宁多列不可漏列），
 * 但每接一个新写方都要显式回来改这里——它是 D3 分级发布的唯一事实来源。
 *
 * 维护纪律：每落一个域切片（新增写方进程），同步更新对应条目 + git 提交说明。
 */
export const DOMAIN_WRITERS = {
  // member：web 客户面登录/资料/收藏（M1 已落）；mzk 代发端登录（M2）；admin 用户管理（现为只读，写路径接入后仍列——保守）
  member: ['web', 'mzk', 'admin'],
  // order：下单面 web/mzk、后台改单 admin、异步任务 worker
  order: ['web', 'mzk', 'admin', 'worker'],
  // finance：余额/充值/支付（写方 = 客户充值 web/mzk、后台调账 admin、对账 Job worker）
  finance: ['web', 'mzk', 'admin', 'worker'],
  // send-order：运单创建/发货（后台 + 代发端为主）
  'send-order': ['web', 'mzk', 'admin', 'worker'],
  logistics: ['mzk', 'admin', 'worker'],
  purchase: ['admin', 'worker'],
  platform: ['worker', 'admin'],
  ticket: ['web', 'mzk', 'admin'],
  content: ['web', 'admin'],
  // openapi：机器面独占（apps/api）
  openapi: ['api'],
  'wms-gateway': ['api', 'worker'],
  // notify 是基础设施包（非域），变更 = 全部消费方
  notify: ['web', 'mzk', 'admin', 'api', 'worker'],
  // admin：后台自己的认证/RBAC（只有 admin app 消费）
  admin: ['admin'],
};

/**
 * contract 域文件名 → 所属域的别名（contract 文件按业务概念命名，实现归进
 * 现有域包——如 favorite 的实现在 packages/domains/member 里）。
 */
export const CONTRACT_DOMAIN_ALIASES = {
  favorite: 'member',
};

/** contract 中「跨域共享」文件——改动影响全部消费 app */
export const CONTRACT_SHARED_FILES = ['src/core.ts', 'src/index.ts'];

/** 这些路径改动 = 纯文档/工具链，无需发版 */
export const NO_DEPLOY_PREFIXES = ['docs/', 'deploy/', 'scripts/', 'skills/', 'memory/'];

/**
 * packages 白名单外的通用包 → 反向依赖由 package.json 实时算；
 * 这里只放「依赖关系说明」需要的补充信息（目前为空，留扩展位）。
 */
export const EXTRA_PACKAGE_NOTES = {};
