---
name: cloudy-cloud-setup
description: Sets up Cloudy Cloud, which runs coding-agent subagents (Claude Code, pi, oh-my-pi, Codex or opencode) on cloud machines. Use when the user says "set up Cloudy Cloud", "install cloudy cloud", "cloudycloud setup", or asks how to get cloudy-cloud working.
---

# Set up Cloudy Cloud

Setup asks for secret keys, so the user runs the installer. You only check the prerequisites and verify the result. Never ask for, read, or handle an API key or token yourself. This skill is for Claude Code. The main session can also be Codex, opencode, pi or free-pi; see step 4.

1. Check the prerequisites with Bash and report anything missing, with where to get it:
   - `node -v` is 20 or later (https://nodejs.org)
   - `git --version`, `npm -v` and `curl --version` work
   - `claude --version` works (https://code.claude.com), but only if the user will run Claude Code or Claude workers. A user who runs only Codex, opencode, pi or free-pi does not need Claude installed.
   - The repo the user will work in has a github.com remote: `git remote get-url origin`
   - `gh auth status` shows a login. This is useful but not required, because setup asks for its own GitHub token.
2. Ask the user to run this in the prompt themselves. The leading `!` runs it in this session:

   ```
   ! npx cloudycloud setup
   ```

   It configures the default Instabox provider unless you pass `--provider NAME`, uses the saved agent list or agents found on PATH (on a fresh install it picks claude alone when it finds it; it asks only if none is found, and `--more` asks anyway), then asks for credentials required by the selected provider, worker profiles and GitHub access. It asks for a Claude token only if Claude Code is a main session or the selected worker profile uses Claude. A user who runs only Codex, opencode or pi needs no Claude token and no `claude` command, but needs at least one worker credential (setup ends with "Setup incomplete" and exits 1 if none is saved). `cloudy-cloud setup --more` adds optional steps: coordinators, usage alert emails and the model keys `PARTICLE_API_KEY`, `OPENROUTER_API_KEY` and `OPENAI_API_KEY`. It may also offer to install the `cloudy-cloud` command (`npm install -g cloudycloud`) and to copy the Cloudy Cloud skills into `~/.claude/skills/`. Tell the user to answer those questions in the terminal. Wait until they say it finished.
3. Verify with `cloudy-cloud setup --check-only`. It checks that the tools are installed and exits with an error if one is missing. It checks the selected provider configuration and the credentials it can validate, and prints a fix command when one is available. It does not test the key values. If `cloudy-cloud` is not found, ask the user to run `npm install -g cloudycloud`, or use `npx cloudycloud setup --check-only`.
4. Explain how to start. From inside a repo with a github.com origin, run `cloudy-cloud` instead of `claude`. For another main session, run `cloudy-cloud codex` (needs `npm install -g @openai/codex`), `cloudy-cloud opencode` (needs `npm install -g opencode-ai`), `cloudy-cloud pi` or `cloudy-cloud free-pi` (these run through `npx` if not installed). Every subagent then runs on its own cloud machine and pushes a `cloudy-cloud/<id>` branch. Workers use the saved default profile, which is Claude Code until changed with `cloudy-cloud setup --default-profile NAME`; a request's `profile` overrides it. `cloudy-cloud mcp-server --repo PATH` provides the tools to another stdio MCP client, and `cloudy-cloud run --repo PATH [--profile NAME] -- PROMPT` runs a worker to completion from a shell. A first test to type: "use a subagent to run hostname, write it to proof.txt, commit and push, and tell me the result". To change a key or worker default later, run `cloudy-cloud setup`.
5. Codex workers need a credential. `cloudy-cloud setup --more` asks for the OpenAI key when codex is one of the agents or is installed (plain setup asks when codex is chosen and no other worker credential is saved); to do it by hand for the `codex` profile, the user creates an OpenAI key and stores it as the Instabox secret `OPENAI_API_KEY` (host `api.openai.com`), then adds the name to `CLOUDY_CLOUD_PROXY_SECRETS`. For `codex-chatgpt`, the user runs `codex login` and then `install -m 600 ~/.codex/auth.json ~/.config/cloudy-cloud/codex-auth.json`. The full commands are on https://cloudycloud.tech/docs/models.html (section "The codex profiles"). Never handle the keys yourself.
