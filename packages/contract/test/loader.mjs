/** 让 node ESM 能吃 tsc 产物的无扩展名相对导入（bundler 风格 → 补 .js） */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js')) {
      return await nextResolve(specifier + '.js', context);
    }
    throw e;
  }
}
