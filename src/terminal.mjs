import { stripVTControlCharacters } from 'node:util';

// Removes terminal control sequences, bidi overrides and tabs from text that came from outside (server names, error messages).
export const safeText = (value) => stripVTControlCharacters(String(value))
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '')
  .replace(/\t/g, ' ');
