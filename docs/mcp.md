# Use devbrief from any agent (MCP)

devbrief ships a small [MCP](https://modelcontextprotocol.io) server, so any
MCP client can read your briefs: Claude Code, Claude Desktop, or another
agent. It has no dependencies (just Node 18+) and runs over stdio.

Every tool is read-only. The server never saves a snapshot, a brief or a
config, and never posts anything.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `devbrief_latest` | none | The latest saved snapshot, summarized: per project, problem counts by severity, the top next step and its flags |
| `devbrief_project` | `name` | Everything the latest snapshot has on one project |
| `devbrief_collect` | `project?`, `offline?` | A fresh snapshot, collected now and not saved (up to two minutes; `offline` skips `git fetch`) |
| `devbrief_brief` | `date?` (`YYYY-MM-DD`) | The saved brief markdown for that date, or the latest one |
| `devbrief_review` | `days?` (default 7) | What shipped in the last N days, from `scripts/review.mjs` |

Results are JSON text, capped at 100 KB with a note when they are cut.
`devbrief_latest` and `devbrief_project` read the snapshot that `/devbrief`
saved, so run a brief (or `devbrief_collect`) first.

## Claude Code plugin

If you installed devbrief as a plugin, the server is already registered. It
starts with the plugin and its tools show up as
`mcp__plugin_devbrief_devbrief__devbrief_latest` and so on. Check it with
`/mcp`.

## Claude Code, manual install

Point Claude Code at `server.mjs` in your clone (use the full path):

```bash
claude mcp add --scope user devbrief -- node /path/to/devbrief/skills/devbrief/mcp/server.mjs
```

`--scope user` makes it available in every project. Remove it with
`claude mcp remove devbrief`.

## Other MCP clients

Most clients (Claude Desktop, Cursor, Windsurf and others) take a JSON config
like this. In Claude Desktop it goes in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "devbrief": {
      "command": "node",
      "args": ["/path/to/devbrief/skills/devbrief/mcp/server.mjs"]
    }
  }
}
```

To use a different data folder or config, add an `env` block with
`DEVBRIEF_HOME` or `DEVBRIEF_CONFIG`, the same variables the collector reads.

On Windows, write the path with forward slashes
(`C:/Users/you/devbrief/...`) or doubled backslashes.

## Protocol notes

- Newline-delimited JSON-RPC 2.0 on stdin and stdout. Logs go to stderr only.
- Answers the `initialize` handshake (protocol versions 2025-11-25 back to
  2024-11-05) and the stateless 2026-07-28 style, where each request carries
  its version in `_meta` and clients may call `server/discover`.
- Supports `ping`, `tools/list`, `tools/call` and `notifications/cancelled`
  (a cancelled `devbrief_collect` stops the collector).
- Unknown methods get `-32601`, unknown tools `-32602`, bad JSON `-32700`, and
  an unsupported `_meta` protocol version `-32022` with the supported list.

## Try it by hand

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"devbrief_latest","arguments":{}}}' \
  | node skills/devbrief/mcp/server.mjs
```
