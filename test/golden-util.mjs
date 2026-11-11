// Golden files: what today's code sends to the provider. `UPDATE_GOLDEN=1 node --test test/golden-*.test.mjs` records them.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

export function golden(name, actual) {
  const file = new URL(`./golden/${name}.json`, import.meta.url);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN) return writeFileSync(file, text);
  assert.equal(text, readFileSync(file, 'utf8'), `${name}.json differs; if the change is intended, record it with UPDATE_GOLDEN=1`);
}

// Variable names of KEY=value lines, never the values.
export const envNames = (text) => String(text).split('\n').map((l) => l.match(/^(?:export )?([A-Z][A-Z0-9_]*)=/)?.[1]).filter(Boolean);
