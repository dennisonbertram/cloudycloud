// What a coordinator's tmux screen says: stuck or dead (BLOCKED), waiting for a person to answer a prompt (WAITING),
// or waiting for a Claude sign-in (the pane's `claude auth login`, or Claude's own login screens).
// Waiting for sign-in is a normal state — the machine stays; only BLOCKED is a failure.
// One place for the patterns, used by `coordinator start`, `login`, `ls`, `status` and the dashboard.
// Only Claude Code's own prompt screens count: a "Do you want to" line is a prompt only when its option lines follow,
// so transcript text that merely starts that way is not an alert.
import { redact } from './events.mjs';
import { safeText } from './terminal.mjs';

const MARKS = /^[\s│|●⎿>*·⏺✗✖!❯-]+/; // box, bullet, prompt and cursor marks Claude Code draws before a line
export const BLOCKED = /^(?:You've hit your [\w -]*limit|Invalid API key ·|Credit balance is too low)/i;
// Claude's own "please sign in" screens. A fresh coordinator is expected to sit at one until the user signs in.
export const SIGNIN = /^(?:Authentication required ·|Login expired ·|Not logged in ·|Select login method)/i;
// Screens a person answers once by attaching; the session is fine, so the machine stays.
export const WAITING = /^(?:.*Do you trust the files|.*trust this folder|New MCP server found|Enable Remote Control|.*Remote Control.*\(y\/n\)|\d\. Yes, I accept)/i;
const QUESTION = /^Do you want to /i, OPTION = /^1\.\s*Yes\b/i;

// A sign-in URL `claude auth login` prints: only a claude.ai, claude.com or platform.claude.com URL counts,
// and never a Remote Control link (those live under /code/). The whole URL is captured, then dropped when it
// exceeds 4096 characters: a too-long URL is never silently truncated into a broken or wrong link.
export const LOGIN_URL = /https:\/\/(?:claude\.ai|claude\.com|platform\.claude\.com)\/(?!code\/)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/;
// The prompt that takes the code the browser showed — `claude auth login` or the in-session /login dialog.
// Its exact wording is unverified, so this matches an enter/paste ... code line loosely.
const CODE_PROMPT = /(?:enter|paste|type|input)\b[^\n]{0,80}\bcode\b|\b(?:authorization|verification|sign-?in|login) code\b|\bcode\b[^\n]{0,40}\bfrom (?:your|the) browser\b/i;
// Only the pane's last 5 non-empty lines can be the live code prompt: transcript text that merely mentions a
// verification code (or an old prompt scrolled up) must not satisfy the `login --code` gate.
const TAIL = 5;

// What a pane shows: the first blocked and waiting lines (each redacted, '' when none); signin is the first
// sign-in line, or 'sign-in' when the pane waits at the sign-in URL or code prompt instead — a coordinator
// waiting for its Claude sign-in shows 'waiting for Claude sign-in', never the line itself.
// `task` is text typed into the session: its own lines are not messages from Claude Code.
export function paneState(pane, task = '') {
  const lines = String(pane ?? '').split('\n').map((l) => l.replace(MARKS, '').trim()).filter((t) => t && !(t.length > 3 && task.includes(t)));
  const pick = (found) => (found ? redact(safeText(found)) : '');
  const asked = lines.find((l, i) => QUESTION.test(l) && lines.slice(i + 1, i + 9).some((o) => OPTION.test(o)));
  const loginUrl = lines.map((l) => { const u = l.match(LOGIN_URL)?.[0]; return u && u.length <= 4096 ? u : undefined; }).find(Boolean) ?? '';
  const codePrompt = lines.slice(-TAIL).some((l) => CODE_PROMPT.test(l));
  const signin = lines.find((l) => SIGNIN.test(l));
  return {
    blocked: pick(lines.find((l) => BLOCKED.test(l))),
    waiting: pick(lines.find((l) => WAITING.test(l)) ?? asked),
    signin: pick(signin) || (codePrompt || loginUrl ? 'sign-in' : ''),
    codePrompt,
    loginUrl,
  };
}
