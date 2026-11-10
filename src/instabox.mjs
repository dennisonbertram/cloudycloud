// Compatibility shim: the Instabox code now lives in src/providers/instabox.mjs.
export { createInstaboxSandbox, attachSecrets, attachGithubToken, withDeleteAfter, workerSeconds } from './providers/instabox.mjs';
