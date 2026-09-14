# Opencode: Never Stop Never Stoppping

An [opencode](https://opencode.ai) plugin that keeps the agent working. When enabled, it watches the current session and, every `checkIntervalSeconds` of idle time, pokes the agent with a message from your config — so no compute goes to waste while the agent sits doing nothing.

## How it works

1. Run `/opencode-never-stop` in a session — the plugin starts monitoring *that* session.
2. Every check it asks opencode for the session's status. If the session is `idle` for more than `checkIntervalSeconds`, the plugin sends the configured nudge message (which triggers a fresh assistant turn).
3. Run `/opencode-stop` at any time — monitoring stops.

Any activity resets the idle timer: agent `busy`, tool calls, streamed message parts, permission replies — all count as "working". We only poke a genuinely idle session.

## Config

Plugin config lives in a plain JSON file (read fresh each time you start it). First match wins:

1. `$OPENCODE_NEVER_STOP_CONFIG`
2. `~/.config/opencode/opencode-never-stop.json` (global, created by the installer)
3. `<project>/.opencode/opencode-never-stop.json` (per-project)

```json
{
  "checkIntervalSeconds": 15,
  "message": "Have you done all your assignments? If anything is left, continue — or spend some more time double-checking your work."
}
```

| Field                  | Default                                                | Description                                              |
| ---------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `checkIntervalSeconds` | `15`                                                   | How many idle seconds before the agent gets nudged       |
| `message`              | `Have you done all your assignments? If anything is left, continue — or spend some more time double-checking your work.` | Text sent to the idle agent |

## Install (local)

### macOS / Linux

```bash
./scripts/install.sh
```

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Both scripts copy the plugin into `~/.config/opencode/plugins/`, register the two commands in `~/.config/opencode/commands/`, and create a default config file (never overwriting an existing one). No dependencies to install — the plugin uses only opencode's own runtime.

> Restart opencode after installing.

## Install (npm)

Make sure the plugin's config JSON exists, then add the package to `plugin` in your `opencode.json`:

```json
{
  "plugin": ["opencode-never-stop"]
}
```

And define the two commands (in `opencode.json` or as `.md` files in `.opencode/commands/`):

```json
{
  "command": {
    "opencode-never-stop": {
      "template": "",
      "description": "Start never stop mode"
    },
    "opencode-stop": {
      "template": "",
      "description": "Stop never stop mode"
    }
  }
}
```

## Commands

| Command                  | Effect                              |
| ------------------------ | ----------------------------------- |
| `/opencode-never-stop`   | Enable monitoring of this session   |
| `/opencode-stop`         | Disable monitoring                  |

The plugin intercepts both commands and empties the prompt, so no prompt content is sent to the model — but a short assistant reply may still appear in the chat after the toggle (that's how slash commands behave).

## License

MIT