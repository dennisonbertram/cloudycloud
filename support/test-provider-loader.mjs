export async function resolve(specifier, context, nextResolve) {
  if (specifier === './instabox.mjs' && context.parentURL?.endsWith('/src/providers/index.mjs')) {
    return { url: new URL('./test-provider-adapter.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
