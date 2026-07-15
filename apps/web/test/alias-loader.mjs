// alias-loader.mjs — node resolve hook for the app's path aliases (@core = the shared
// consensus package, @ = apps/web/src). Vite resolves these for the browser build
// (vite.config.js resolve.alias); plain node — which runs this test suite — needs this hook.
const CORE = new URL('../../../core/', import.meta.url);
const SRC = new URL('../src/', import.meta.url);
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@core/')) return next(new URL(specifier.slice('@core/'.length), CORE).href, context);
  if (specifier.startsWith('@/')) return next(new URL(specifier.slice('@/'.length), SRC).href, context);
  return next(specifier, context);
}
