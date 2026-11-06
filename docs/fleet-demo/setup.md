# Setup

1. Clone the repo and run `./install.sh` in a terminal; it checks your tools, runs `npm install`, and links `claude-cloud` onto your PATH.
2. You need three accounts: an [Instabox](https://instabox.sh) account (a paid plan for more than a few subagents at once), a Claude subscription or Anthropic API key, and a GitHub repository you can push to.
3. Your machine needs `git`, Node.js 20 or later, and Claude Code, signed in.
4. `install.sh` asks for three keys: an Instabox API key, a Claude token from `claude setup-token`, and a fine-grained GitHub token that it stores as the Instabox secret `GH_TOKEN`.
5. Then run `claude-cloud` from inside a git repo that has a GitHub `origin` remote.
