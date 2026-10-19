# Getting started: install your first Agent Plugin

In this tutorial we will install the [Context7](https://github.com/upstash/context7)
Agent Plugin into an OpenCode project and confirm that its skill and MCP
server reach a session.

## What you need

- OpenCode 2 installed (the client is verified against the release pinned
  in `package.json`).
- Node.js >= 26, for the CLI.
- `git`, for the git-backed CLI commands.
- A project directory you can open OpenCode in.

## 1. Install the plugin

Open a terminal in your project directory and run:

```sh
npx opencode-agent-plugins install \
  https://github.com/upstash/context7.git#:plugins/agent-plugins/context7
```

The CLI fetches the source, validates it, and prints what it would
register. The output looks something like this (versions and commits
change over time):

```text
Plugin: context7 v1.0.1
Source: https://github.com/upstash/context7.git#:plugins/agent-plugins/context7 (commit ef472a4912d5)
Skills:  context7-mcp
MCP:     context7 (remote) https://mcp.context7.com/mcp/oauth
warn:    your opencode config has no "opencode-agent-plugins" plugin entry; OpenCode will not load it for the registered source
config:   /path/to/your/project/opencode.json
```

Because the project has no `opencode-agent-plugins` entry yet, the CLI
asks two questions:

1. **Add the "opencode-agent-plugins" entry to your opencode config so the
   source is loaded? [Y/n]** — press Enter (yes). Without this entry
   OpenCode would never load the registered source.
2. **Install this plugin? [y/N]** — type `y` and press Enter.

The last line confirms the result:

```text
installed context7 1.0.1. Restart OpenCode to use it.
```

## 2. Look at what changed

The CLI registered the source in your project's `opencode.json` and copied
the plugin into the client store (`~/.local/share/opencode/agent-plugins`
by default). The config now contains:

```json
{
  "plugins": [
    {
      "package": "opencode-agent-plugins",
      "options": {
        "plugins": [
          "https://github.com/upstash/context7.git#:plugins/agent-plugins/context7"
        ]
      }
    }
  ]
}
```

The source string is stored exactly as you typed it; the store copy and
its metadata live outside the config. See the
[configuration reference](../reference/configuration.md) for the store
layout and the other options.

## 3. Reload OpenCode

Start (or restart) OpenCode in the project. OpenCode V2 also watches its
configuration and reloads the plugin on its own, but a restart is the
deterministic way to pick up the change.

## 4. Use the skill

The plugin registers the `context7-mcp` skill. In a prompt, mention the
skill by its ID to load it:

```text
@context7-mcp how do I configure a custom server in the current project?
```

OpenCode loads the skill's instructions into the conversation before the
model answers. If the mention does not resolve, restart OpenCode; if it
still does not, check the `[opencode-agent-plugins]` log lines (see
[Debug the plugin in a live OpenCode](../guides/debugging.md)).

## 5. Use the MCP tools

The plugin also registers the `context7` MCP server, so its tools reach
the model. Ask OpenCode to use them, for example:

```text
Use the context7 tools to look up the documentation for zod.
```

The tools are wrapped in Code Mode by default: the model calls them as
`tools.context7.<tool>` inside the `execute` tool, exactly like
natively-configured servers. If the remote server needs authentication,
OpenCode reports it; run `/mcps`, select `context7`, and sign in.

Note: `opencode mcp list` lists servers configured in OpenCode's own
config; plugin-registered servers live in the plugin registry, so they do
not appear there — use their tools to verify them.

## Next steps

- Keep the plugin up to date:

  ```sh
  npx opencode-agent-plugins check    # read-only; exit code 2 when an update is available
  npx opencode-agent-plugins update
  ```

- Remove it again: `npx opencode-agent-plugins remove context7`.
- [CLI reference](../reference/cli.md) — every command, flag, and exit
  code.
- [Configuration reference](../reference/configuration.md) — sources,
  options, and the client store.
