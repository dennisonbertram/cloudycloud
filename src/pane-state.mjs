// What a coordinator's tmux screen says: stuck or dead (BLOCKED), or waiting for a person to answer a prompt (WAITING).
// One place for the patterns, used by `coordinator start`, `ls`, `status` and the dashboard.
import { redact } from './events.mjs';
import { safeText } from './terminal.mjs';

const LEAD = String.raw`^[\s│|●⎿>*·⏺✗✖!-]*`; // box, bullet and prompt marks Claude Code draws before a message
export const BLOCKED = new RegExp(`${LEAD}(?:You've hit your [\\w -]*limit|Authentication required ·|Login expired ·|Invalid API key ·|Not logged in ·|Credit balance is too low|Select login method)`, 'i');
// Screens a person answers once by attaching; the session is fine, so the machine stays. Includes a permission prompt
// ("Do you want to ...") and the one-time bypass-mode confirmation, which should not appear on a coordinator (#88).
export const WAITING = new RegExp(`${LEAD}(?:.*Do you trust the files|.*trust this folder|New MCP server found|Enable Remote Control|.*Remote Control.*\\(y/n\\)|Do you want to |.*Bypass Permissions mode|\\d\\. Yes, I accept)`, 'i');

// The first blocked line and the first waiting line of a screen (each redacted, '' when none).
// `task` is text typed into the session: its own lines are not messages from Claude Code.
export function paneState(pane, task = '') {
  const mine = (l) => { const t = l.trim(); return t.length > 3 && task.includes(t); };
  const lines = String(pane ?? '').split('\n').filter((l) => !mine(l));
  const pick = (re) => { const l = lines.find((x) => re.test(x)); return l ? redact(safeText(l.trim().replace(/^[│|●⎿>*·⏺✗✖!\s-]+/, ''))) : ''; };
  return { blocked: pick(BLOCKED), waiting: pick(WAITING) };
}
