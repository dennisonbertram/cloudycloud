---
name: cloudy-cloud-setup
description: Sets up Cloudy Cloud, which runs Claude Code subagents on cloud machines. Use when the user says "set up Cloudy Cloud", "install cloudy cloud", "cloudycloud setup", or asks how to get cloudy-cloud working.
---

# Set up Cloudy Cloud

Setup asks for secret keys, so the user runs the installer. You only check the prerequisites and verify the result. Never ask for, read, or handle an API key or token yourself.

1. Check the prerequisites with Bash and report anything missing, with where to get it:
   - `node -v` is 20 or later (https://nodejs.org)
   - `git --version`, `npm -v` and `curl --version` work
   - `claude --version` works (https://code.claude.com)
   - The repo the user will work in has a github.com remote: `git remote get-url origin`
   - `gh auth status` shows a login. This is useful but not required, because setup asks for its own GitHub token.
2. Ask the user to run this in the prompt themselves. The leading `!` runs it in this session:

   ```
   ! npx cloudycloud setup
   ```

   It asks for an Instabox API key, a Claude token and a GitHub token. It may also offer to install the `cloudy-cloud` command (`npm install -g cloudycloud`) and to copy the Cloudy Cloud skills into `~/.claude/skills/`. Tell the user to answer those questions in the terminal. Wait until they say it finished.
3. Verify with `cloudy-cloud setup --check-only`. It checks that the tools are installed and exits with an error if one is missing. It does not check the keys. If `cloudy-cloud` is not found, ask the user to run `npm install -g cloudycloud`, or use `npx cloudycloud setup --check-only`.
4. Explain how to start. From inside a repo with a github.com origin, run `cloudy-cloud` instead of `claude`. Every subagent then runs on its own cloud machine and pushes a `cloudy-cloud/<id>` branch. A first test to type: "use a subagent to run hostname, write it to proof.txt, commit and push, and tell me the result". To change a key later, run `cloudy-cloud setup`.
