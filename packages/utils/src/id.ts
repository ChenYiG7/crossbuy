/** 品牌类型：给裸类型打标签，防止不同域的 id/金额/单号互相误用（编译期拦截） */
export type Brand<T, B extends string> = T & { readonly __brand: B };
