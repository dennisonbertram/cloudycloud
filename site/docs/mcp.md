# MCP servers for subagents

> Choose which of your MCP servers cloud subagents get with cloudy-cloud mcp add, what is allowed, and how tokens stay in Instabox.

Source: https://cloudycloud.tech/docs/mcp.html

Cloud subagents have no MCP servers unless you choose some. `cloudy-cloud mcp add` copies a server from your Claude Code settings to the list that every cloud subagent gets. It is off until you add one.

## Add a server

Three steps. Replace `notion` with the name Claude Code shows in `claude mcp list`.

1. Copy the server: `cloudy-cloud mcp add notion`. It finds the server in your Claude Code settings, shows what it found, and saves it.
2. If the server needs a token, run the `secrets set` command that step 1 printed. You run it once per token.
3. Start subagents as usual. The reply ends with a line such as `MCP servers: notion`.

This is the output for a server that sends a token in a header:

```
cloudy-cloud mcp add notion
Found notion in ~/.claude.json (user scope):
  type     http
  url      https://mcp.notion.com/mcp
  headers  Authorization: Bearer ntn_…9f3a
This server sends a secret. Cloud machines run Claude with permission checks off, so the value is not copied.
It is written as ${MCP_NOTION_TOKEN}; Instabox adds the real value to requests to mcp.notion.com only.
  Store it once:  printf %s "$TOKEN" | npx --yes instabox@latest secrets set MCP_NOTION_TOKEN --host mcp.notion.com
Added notion to ~/.config/cloudy-cloud/mcp.json. Every cloud subagent you start from now on gets it.
```

Run the stored-once command with the real token in `$TOKEN`. It must be an Instabox secret created with your `instabox login` session. Creating a secret with the Instabox API key from your cloudy-cloud config fails with `missing_scope: workspace:admin`. If you have not signed in, run `npx --yes instabox@latest login` first.

The list is read each time a subagent starts, so you do not need to restart `cloudy-cloud`. Subagents that are already running keep the servers they started with.

### Where the server is found

It searches your Claude Code settings in this order and uses the first match: the local scope (the entry for the current folder in `~/.claude.json`), the project scope (`.mcp.json` in the repo root), then the user scope (`mcpServers` in `~/.claude.json`). The first output line says which one it used. If the name is not found, it prints `No MCP server named NAME in your Claude Code config. See: claude mcp list` and exits with status 1.

If the name is already in the list, the command prints `Replacing the existing NAME entry.` and overwrites it.

## Commands

| Command | What it does |
|---|---|
| `cloudy-cloud mcp add NAME` | Copies one server from Claude Code's settings to `~/.config/cloudy-cloud/mcp.json`. A token is replaced by a reference and the command to store it is printed. |
| `cloudy-cloud mcp add NAME --allow-literal` | The consent path. See Putting the real token on the machine. |
| `cloudy-cloud mcp ls` | Lists the servers subagents get, one per line: name, type, target (the host, or the `npx` or `uvx` package) and the secrets it needs. With none, it prints `No MCP servers are shared with cloud subagents. Add one with: cloudy-cloud mcp add <name>`. |
| `cloudy-cloud mcp rm NAME` | Removes one server from the list. It does not delete the Instabox secret; use `npx --yes instabox@latest secrets rm MCP_NAME_TOKEN` for that. |

Any other `cloudy-cloud mcp` command, such as `cloudy-cloud mcp list`, goes to Claude Code's own `claude mcp`.

## What can be copied

A cloud machine cannot reach your computer, so only two kinds of server work:

- **Remote servers** of type `http` or `sse` with an `https` URL on a public host. Headers are allowed.
- **`npx` and `uvx` servers** (stdio). The command must be exactly `npx` or `uvx`, because those are installed on the machine.

Everything else is refused with a reason on the line `Not added: REASON`, and `mcp add` exits with status 1:

| Reason you may see | Why |
|---|---|
| `the command is X; only npx and uvx servers can run on a cloud machine` | A local program or script is not on the machine. |
| `arg X is a local path, which does not exist on the machine` | An argument starts with `/`, contains `~` or has a `..` part. |
| `url points at localhost, which does not exist on the machine` | The host is `localhost`, `*.local`, `0.0.0.0`, `::1`, or a `127.*`, `10.*`, `192.168.*` or `172.16-31.*` address. |
| `url must be https` | Plain `http` URLs are not copied. |
| `uses OAuth sign-in, which a headless subagent cannot complete` | A subagent cannot open a browser to sign in. |
| `uses headersHelper, a local script the machine does not have` | The script would not exist on the machine. |
| `type X is not supported on a cloud machine` | Only `http`, `sse` and stdio are accepted. |
| `url carries a secret value; send it in a header instead, ...` and `an argument carries a secret value; pass it in env instead, ...` | A key in a URL or an argument would sit on the machine as plain text. Instabox replaces tokens only in request headers. |
| `references ${X}; cloud machines only expand MCP_<NAME>_TOKEN secrets` | Other `${...}` variables are not available on the machine. |

The same checks run again every time a subagent starts, on whatever is in `mcp.json`.

> Warning: These are limits of the current version: no OAuth servers, no servers that run from a local path or listen on localhost, no secrets in URLs or arguments, and no MCP servers for the `pi` profiles (`pi-glm`, `pi-deepseek`, `pi-particle`). A `pi` worker gets none.

## Tokens and secrets

The token is never written to `mcp.json`. `mcp add` replaces each secret value in `env` or `headers` with `${MCP_<NAME>_TOKEN}`. `NAME` is the server name in capitals with `-` changed to `_`, so `notion` becomes `MCP_NOTION_TOKEN`. A second secret on the same server is `MCP_<NAME>_2_TOKEN`, and so on. A header is treated as secret when it is `Authorization`, its value starts with `Bearer`, its name ends in `KEY`, `TOKEN`, `SECRET` or `PASSWORD`, or the value looks like a known key format. The same name rule applies to `env` values.

You store the real value once in Instabox with the command `mcp add` prints:

```
printf %s "$TOKEN" | npx --yes instabox@latest secrets set MCP_NOTION_TOKEN --host mcp.notion.com
```

- For a remote server, `--host` is the URL's host.
- For an `npx` or `uvx` server, `mcp add` asks `Which HTTPS hosts does this server send the token to? (comma-separated, exact hostnames, required)`. It does not accept an empty answer. It also needs a terminal for that question. Without one it prints `Not added: a secret without a host list would be sent to any host the subagent reaches.`
- Never create the secret without `--host`. Instabox would then add the value to a request to any host, so a prompt injection could send it to a server the attacker controls.
- Instabox replaces the placeholder only in HTTPS request headers sent to the listed hosts. Both `Authorization: Bearer ...` and a custom header name were checked this way, from `curl` and from Node `fetch`. To other hosts the machine's placeholder stays a placeholder.

When a subagent starts, all the secret names it needs are attached to its machine together with `GH_TOKEN`. If one does not exist, the start fails with a message such as:

```
The Instabox secret MCP_NOTION_TOKEN could not be attached. Create it with: printf %s "$TOKEN" | npx --yes instabox@latest secrets set MCP_NOTION_TOKEN --host <host>
```

If the Instabox error does not name the secret, the message is the usual `GH_TOKEN` one, followed by `Secrets tried: GH_TOKEN, MCP_NOTION_TOKEN`.

Two server names that map to the same secret name (`my-srv` and `my_srv`) cannot both be added. `mcp add` prints `Not added: OTHER already uses MCP_MY_SRV_TOKEN. Rename one of the two servers in Claude Code first.`

> Note: A subagent can still *use* the token against the listed hosts, the way it can use `GH_TOKEN` against GitHub. It cannot read the real value.

### Putting the real token on the machine

Some servers cannot work with a placeholder, for example one that does not send the token in a header. For those, `cloudy-cloud mcp add NAME --allow-literal` keeps the real value in `mcp.json` and copies it to every cloud machine. It only applies to values in `env` and `headers`. It is off unless you pass the flag.

> Warning: With `--allow-literal`, the real token sits on the machine in a file with mode 600. Cloud machines run Claude with permission checks off, so a prompt injection in a web page or file could make the agent send that token anywhere. Use a token you can revoke and that has the least access it needs.

The command prints this warning, then asks `Copy the real NAME token onto cloud machines? [y/N]`. Anything other than `y` or `yes` cancels it with `Not added. Run without --allow-literal to keep the token in Instabox.` It also needs a terminal, so you can confirm. Without one it prints `Not added: --allow-literal needs a terminal so you can confirm.` No Instabox secret is created for a server added this way. The entry in `mcp.json` gets `"cloudyCloudAllowLiteral": true`, which is removed before the file is sent to the machine. Remove the server with `cloudy-cloud mcp rm NAME`.

## Files and what the machine gets

- `~/.config/cloudy-cloud/mcp.json` on your computer, in Claude Code's own format: `{"mcpServers": {...}}`. `mcp add` writes it with mode 600 in a folder with mode 700. Set `CLOUDY_CLOUD_MCP` to use another path. If the file does not exist, the feature is off and nothing changes. If it is not valid JSON, `cloud_agent` fails with `Could not read FILE: ...` and the parse error.
- On each cloud machine, the checked servers are written to `~/.config/cloudy-cloud/mcp.json` (mode 600), and Claude is started with `--mcp-config` for that file and `--strict-mcp-config`. This happens only for Claude subagents and only when at least one server passed the checks.
- Because of `--strict-mcp-config`, a repo's own `.mcp.json` is not loaded on the machine once you have a server in the list. Without the list, nothing changes from before.
- Coordinators get the same list. The list holds references, not secret values, so it adds no secret to a coordinator machine.

## See which servers a subagent had

- **The reply footer** ends with a line such as `MCP servers: notion, context7 (failed: linear)`. It lists the servers that connected and, in brackets, the ones that did not. If none connected it says `MCP servers: none connected`.
- If you allowed a real token, another line says `MCP servers with a real token on the machine (you allowed it): NAME`.
- Entries that did not pass the checks appear as `MCP servers skipped: NAME (REASON)`.
- For a `pi` worker the line is `MCP servers: none (pi workers do not get MCP servers yet)`.
- **`cloud_agent_list`** shows a line `mcp notion, context7` under each subagent that has servers.
- **The dashboard** shows an MCP row in the agent's details with the server names. It never shows entries or tokens.

The footer lines appear only when the list has servers or skipped entries.
