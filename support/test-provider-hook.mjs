import { register } from 'node:module';

register(new URL('./test-provider-loader.mjs', import.meta.url), import.meta.url);
