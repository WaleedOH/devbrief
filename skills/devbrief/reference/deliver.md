# send and speak

`/devbrief send [ntfy|discord|desktop,...]` delivers the brief to the user's
phone, a Discord channel or a desktop notification. `/devbrief speak` reads it
out loud. Both work on a brief that is already saved.

## 1. Make sure today's brief exists

Look for `~/.devbrief/briefs/<today>.md` (or under `$DEVBRIEF_HOME`). If it is
missing, write the brief first (the normal `/devbrief` flow) and save it there.
Never deliver yesterday's brief as if it were today's; if the user asks for an
older one, pass it with `--file` and say which date it is.

## 2. Deliver

Run from this skill's base directory:

```
node scripts/deliver.mjs                      # the config's default channels
node scripts/deliver.mjs --to ntfy,discord    # the channels the user named
node scripts/deliver.mjs --speak              # speak only
node scripts/deliver.mjs --to desktop --speak # both
```

`--dry-run` shows each message without sending anything; use it when the user
is setting delivery up or asks "what would it send". `--file <path>` picks
another brief.

It prints one line per channel, such as `devbrief: ntfy: sent 412 characters`
or `devbrief: discord failed: set DEVBRIEF_DISCORD_WEBHOOK to ...`, and exits 1
only if every channel failed. Report each line in plain words. Never print or
repeat the value of a topic or webhook variable: those are secrets.

What each channel gets:
- ntfy: a short version (Do first plus red and yellow lines), since phones cut
  long notifications.
- discord: the whole brief, split into up to 4 messages of 2000 characters.
- desktop: "devbrief" and the top Do first action.
- speech: about a minute: Do first, then how many projects are red, yellow and
  healthy. If no speech program is installed, the script is printed instead
  and the line says what to install.

## 3. If a channel is not set up

Tell the user what to do, one channel at a time, and do not set secrets for
them in any file:

- ntfy (free, no account): install the ntfy app, subscribe to a topic with a
  long random name (anyone who knows the name can read it), then set
  `DEVBRIEF_NTFY_TOPIC` to that name in their shell profile or scheduler.
  Suggest a name like `devbrief-` plus 20 random letters.
- Discord: Server settings > Integrations > Webhooks > New webhook, copy the
  URL, set `DEVBRIEF_DISCORD_WEBHOOK` to it.
- desktop: works out of the box on Windows and macOS; Linux needs
  `notify-send` (package `libnotify-bin` or `libnotify`).
- speech: Windows and macOS have it built in; Linux needs `spd-say`
  (speech-dispatcher) or `espeak-ng`.

The variable names can be changed in the config:

```json
"deliver": {
  "ntfy": { "topicEnv": "DEVBRIEF_NTFY_TOPIC", "server": "https://ntfy.sh" },
  "discord": { "webhookEnv": "DEVBRIEF_DISCORD_WEBHOOK" },
  "desktop": true,
  "default": ["ntfy"]
}
```

## 4. Making it automatic

- After every brief: when the config has `"deliver": { "afterBrief": true }`,
  run `node scripts/deliver.mjs` right after saving the brief, and add its
  result lines at the end of the chat reply. If the user asks for this, tell
  them to add that key (with `default` set to their channels); do not edit the
  config without asking.
- From a scheduled run (cron, Task Scheduler, a cloud job): run the brief, then
  `node <skill>/scripts/deliver.mjs`. The env vars must be set in that
  scheduler, not only in an interactive shell. See docs/deliver.md for
  examples.
