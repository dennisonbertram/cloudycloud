# Dashboard and app previews

> Watch your cloud agents in a local web page and open apps running on their machines.

Source: https://cloudycloud.tech/docs/dashboard.html

The dashboard is a read-only web page on your own computer that shows your cloud agents and the messages between them and your session. To look at an app a cloud agent is running, use `cloudy-cloud open`.

## Start the dashboard

```
cloudy-cloud dashboard
```

This prints a link and opens it in your browser. The page is served from `127.0.0.1` on port 4477, or on a free port if 4477 is taken. Press Ctrl+C in the terminal to stop it.

| Option | What it does |
|---|---|
| `--demo` | Shows sample data, so you can look around before you have started any agents. |
| `--port N` | Uses port N (0 to 65535). |
| `--no-open` | Prints the link without opening a browser. |

## What it shows

The page has two views, switched at the top: **List** and **Fleet**.

- **List** has the boxes in a left column and the selected box in a detail pane.
- **Fleet** shows one tile per box, with its status, description, id and time since last activity. Select a tile to open it in the List view.

Boxes are grouped as **Needs you**, **Active** and **Finished**.

- **Needs you:** agents that are idle, and agents that failed today.
- **Active:** agents that are queued, starting or running.
- **Finished:** everything else.

The top bar counts running, starting, idle and failed agents and those finished today. The browser tab title shows the failed and idle counts.

### The detail pane

Select a box to see:

- **Status**, **Model** (or profile) and **Started**.
- **MCP**: the names of the MCP servers the subagent has, when it has any.
- **Branch**: the `cloudy-cloud/<id>` branch, with the result of the last push (the commit hash, or "push failed"), and copy buttons.
- **Deletes**: when the machine is expected to be deleted, for an agent that is still active or idle. For an idle agent this is 60 minutes after it went idle. For an active agent the dashboard shows 8 hours after it started. That is only an upper estimate: the server deletes a worker machine at its own deadline, 6 hours after it starts by default (`CLOUDY_CLOUD_WORKER_HOURS`, at most 24), which can be earlier.
- **Open app**: for a running or idle agent, the command `cloudy-cloud open <id> <port>` with a copy button. See below.
- **Activity**: a timeline of the task you sent, follow-up messages, progress steps, and the agent's replies.

### When something is wrong

- **Offline:** the page cannot reach the dashboard server. It keeps the last list, shows the time of the last update, and retries every 3 seconds. If it has no list yet, it shows *The dashboard cannot reach its server*. Start the server again with `cloudy-cloud dashboard` and open the new link.
- **Old link:** each run makes a new link. A link from an earlier run is refused: a page that is already open shows *This link is from an earlier run*, and a request without the right token gets the text *This dashboard link is missing its access key, or it is from an earlier run.* Open the newest link in your terminal, or run `cloudy-cloud dashboard` again.
- **Live machines unavailable:** a banner appears if the Instabox machine list cannot be read, for example when `INSTABOX_API_KEY` is missing or invalid. Session history still shows.
- **No boxes yet:** an empty list means you have not started an agent from a `cloudy-cloud` session.

## What it cannot show

- **Sessions started before the event log existed.** Their agents have no history. If the machine is still running, it appears as a bare machine with no messages.
- **A cloud coordinator's messages.** A cloud coordinator runs on its own machine, so its messages are not recorded on your computer. It appears as a machine, and its workers appear as machines without a session log. Nested coordinators log on their own machine too.
- **Queued agents.** A queued agent is shown as *starting*.
- **Ended sessions.** An agent from a session that has since ended is shown as stopped.

## Security model

- **Local only.** The server listens on `127.0.0.1`. It answers only requests whose `Host` is `localhost` or `127.0.0.1`.
- **Per-run token.** Each run makes a random token that is part of the link. A request without it gets a 401.
- **Read-only.** It accepts only GET and HEAD requests. It cannot start, message or stop an agent.
- **Keys stay out of the browser.** The Instabox key is used only by the server. Error text is redacted before it is sent to the page.
- **The event log is private to you.** The log is `~/.config/cloudy-cloud/events.jsonl` (set `CLOUDY_CLOUD_EVENTS` to move it), in a folder with mode 700, with file mode 600. Exact secret values are removed, and key-shaped text such as `sk-…`, `ghp_…`, `NAME_KEY=…` and bearer tokens is redacted, before anything is written. Each text is cut at 20,000 characters.

> Note: Prompts and replies can contain your code, and redaction only catches key-shaped text. Treat the log as private. It is never rotated; delete the file to clear the history. The dashboard reads the newest 16 MB of it.

## Reach an app running on an agent's machine

If an agent starts a dev server or a web app, you can view it from your own browser. The dashboard shows the command for each running agent in its **Open app** row. Replace `<port>` with the port the app uses.

### Private tunnel

```
cloudy-cloud open AGENT_ID 3000
```

This forwards `http://127.0.0.1:3000` on your computer to port 3000 on the agent's machine, until you press Ctrl-C. Use an agent id from `cloud_agent_list` (the `<id>` in branch `cloudy-cloud/<id>`), a machine name or a machine id. A coordinator's machine is named `coord-NAME`. To use a different local port, write `LOCAL:REMOTE`, for example `8080:3000`. Only you can reach the tunnel.

### Share a private link

```
cloudy-cloud open AGENT_ID 3000 --share
```

This prints a private link with a token in the URL. It never publishes the app publicly.

> Warning: Anyone who has the link can open the app, until the machine is deleted or you remove the link. Share it only with people who should see the app, and do not paste it where others can read it.

Remove the link with:

```
cloudy-cloud open AGENT_ID 3000 --unshare
```

`--share` and `--unshare` take a single port, not `LOCAL:REMOTE`.

### Two limits

**Start the app in the background.** A turn's foreground processes end with the turn. Ask the agent to run the app like this:

```
nohup npm run dev > /tmp/dev.log 2>&1 &
```

2. **The tunnel and link stop when the machine is deleted.** A worker machine is deleted after 60 idle minutes, when the session ends, or at its deadline (6 hours by default). A coordinator lives longer (24 hours by default).

The command uses the Instabox CLI (`npx --yes instabox@latest`), so you must be signed in to Instabox. If it says you are not, run `cloudy-cloud setup`. If the agent's machine is not running, the command says so and you need to start a new agent.

For running many agents, see [Coordinators and fleets](https://cloudycloud.tech/docs/fleets.html).
