# Deliver the brief: phone, Discord, desktop, voice

`skills/devbrief/scripts/deliver.mjs` sends a saved brief somewhere you will
see it. In Claude Code: `/devbrief send` and `/devbrief speak`.

```
node skills/devbrief/scripts/deliver.mjs                     # default channels
node skills/devbrief/scripts/deliver.mjs --to ntfy,desktop   # pick channels
node skills/devbrief/scripts/deliver.mjs --speak             # read it out loud
node skills/devbrief/scripts/deliver.mjs --dry-run           # show, send nothing
node skills/devbrief/scripts/deliver.mjs --file brief.md     # not today's brief
```

It reads today's brief from `~/.devbrief/briefs/<date>.md` (or
`$DEVBRIEF_HOME/briefs/`), prints one line per channel, and exits 1 only when
every channel failed. Everything it uses is free and needs no subscription.

| Channel | What arrives | Setup |
|---|---|---|
| `ntfy` | Do first plus red and yellow lines (phones cut long text) | Install the [ntfy](https://ntfy.sh) app, subscribe to a topic, set `DEVBRIEF_NTFY_TOPIC` |
| `discord` | The whole brief, in up to 4 messages | Server settings > Integrations > Webhooks, set `DEVBRIEF_DISCORD_WEBHOOK` |
| `desktop` | "devbrief" and the top Do first action | Built in on Windows and macOS; Linux needs `notify-send` |
| `--speak` | About a minute: Do first, then the counts | Built in on Windows and macOS; Linux needs `spd-say` or `espeak-ng` |

**ntfy topics are public by name.** Anyone who guesses yours can read your
briefs, so use a long random one, such as `devbrief-` plus 20 random letters.
To use your own ntfy server, set `server` in the config.

## Config

Secrets never go in the config file. It only names the environment variables
that hold them:

```json
"deliver": {
  "ntfy": { "topicEnv": "DEVBRIEF_NTFY_TOPIC", "server": "https://ntfy.sh" },
  "discord": { "webhookEnv": "DEVBRIEF_DISCORD_WEBHOOK" },
  "desktop": true,
  "default": ["ntfy"],
  "afterBrief": false
}
```

`default` is used when you pass no `--to`. `afterBrief: true` makes Claude send
the brief right after writing it. `desktop: false` turns desktop toasts off.

## From a schedule

Write the brief on a schedule (see the README), then deliver it. Set the
variables in the scheduler itself; it does not read your shell profile.

```
# cron, weekdays at 08:00
0 8 * * 1-5  DEVBRIEF_NTFY_TOPIC=devbrief-xxxxxxxxxxxxxxxxxxxx node ~/devbrief/skills/devbrief/scripts/deliver.mjs
```

On Windows, set the variable once with `setx DEVBRIEF_NTFY_TOPIC devbrief-xxxx`
and point a Task Scheduler action at `node.exe` with the script path as its
argument.

## Safety

- Text is passed to PowerShell, `say`, `spd-say` and `espeak` on standard
  input, and to `osascript` and `notify-send` as separate arguments, never
  pasted into a shell command, so a brief cannot run code.
- Discord messages are sent with mentions turned off, and errors never print
  the webhook URL.
- `--dry-run` sends nothing and runs no program.
