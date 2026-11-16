// What a coordinator's tmux screen says: stuck or dead (BLOCKED), or waiting for a person to answer a prompt (WAITING).
// One place for the patterns, used by `coordinator start`, `ls`, `status` and the dashboard.
// Only Claude Code's own prompt screens count: a "Do you want to" line is a prompt only when its option lines follow,
// so transcript text that merely starts that way is not an alert.
import { redact } from './events.mjs';
import { safeText } from './terminal.mjs';

const MARKS = /^[\s│|●⎿>*·⏺✗✖!❯-]+/; // box, bullet, prompt and cursor marks Claude Code draws before a line
export const BLOCKED = /^(?:You've hit your [\w -]*limit|Authentication required \u00b7|Login expired \u00b7|Invalid API key \u00b7|Not logged in \u00b7|Credit balance is too low|Select login method)/i;
// Screens a person answers once by attaching; the session is fine, so the machine stays.
export const WAITING = /^(?:.*Do you trust the files|.*trust this folder|New MCP server found|Enable Remote Control|.*Remote Control.*\(y\/n\)|\d\. Yes, I accept)/i;
const QUESTION = /^Do you want to /i, OPTION = /^1\.\s*Yes\b/i;

// The first blocked line and the first waiting line of a screen (each redacted, '' when none).
// `task` is text typed into the session: its own lines are not messages from Claude Code.
export function paneState(pane, task = '') {
  const lines = String(pane ?? '').split('\n').map((l) => l.replace(MARKS, '').trim()).filter((t) => t && !(t.length > 3 && task.includes(t)));
  const pick = (found) => (found ? redact(safeText(found)) : '');
  const asked = lines.find((l, i) => QUESTION.test(l) && lines.slice(i + 1, i + 9).some((o) => OPTION.test(o)));
  return { blocked: pick(lines.find((l) => BLOCKED.test(l))), waiting: pick(lines.find((l) => WAITING.test(l)) ?? asked) };
}
