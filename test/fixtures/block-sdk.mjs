// Preload (node --import): any attempt to resolve the Instabox SDK fails, so a test can prove a process never loads it.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('@insforge/')) throw new Error('SDK_LOADED ' + specifier);
    return next(specifier, context);
  }
`));
