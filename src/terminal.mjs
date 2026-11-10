import { stripVTControlCharacters } from 'node:util';

// Removes terminal control sequences and tabs from text that came from outside (server names, error messages).
export const safeText = (value) => stripVTControlCharacters(String(value))
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '')
  .replace(/\t/g, ' ');

// Hides anything shaped like a key or token before an error is printed.
export const redact = (text) => text.replace(/\b(?:sk-|ghp_|gho_|github_pat_|ibk_)[A-Za-z0-9_-]+/g, '[redacted]');
