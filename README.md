# Discord Bandev Bot

Discord bot for Mini World **`!bandev`** — **immediate execution** with an
**automatic 3-minute repeat** for the whole duration.

## How it works

`bandev.daxterrantares.workers.dev/?bandev=<UID>` bans the target device for
about **3 minutes** per call. So when you run a duration command, the bot:

1. Fires the **first** request immediately.
2. Re-fires the **same UID every 3 minutes** (local scheduler).
3. Stops automatically when the duration ends.

Example — `!bandev 1000 1day`:
- Fire #1 right away → device banned ~3 min.
- Fire #2 at +3 min → banned another ~3 min.
- …keeps repeating every 3 min… → total **24 hours**.
- At +24h the bot stops re-firing on its own.

`1day` = 24h, `7days` = 7 days, `5m` / `2hours` also work.

## Commands (all public, all replies are embeds)

- `!bandev <UID> [duration]` — ban a UID (fires now, repeats every 3 min until duration ends).
- `!unban <UID>` — stop an active ban.
- `!bandevlist` — list active bans.
- `!debug` — scheduler status (uptime, next fire time).
- `!help` — show commands.

**Replies go back in the channel** where the command was typed. In addition, the
**owner** gets a **DM notification** with full details (who ran it, target UID,
player name) every time someone uses `!bandev`.

## Caveats

- The schedule is kept **in-process** (`data/bans.json`). If the process restarts
  / redeploys, active duration schedules are lost (just re-run the command).
- `!unban` stops the repeats going forward. Each already-fired request's ~3 min
  effect simply wears off on its own.
- This is the *join-room / device-ban* action — the target can still log in;
  the repeat keeps re-applying the ~3 min ban for the duration.

## Setup

```bash
npm install
cp .env.example .env      # then fill in your values
npm start
```

### Discord Developer Portal

1. Create an app at <https://discord.com/developers/applications>.
2. **Bot** → create a bot → copy the **Token** into `DISCORD_TOKEN`.
3. Enable **Message Content Intent** under Bot → Privileged Gateway Intents
   (required so the bot can read `!`-prefixed messages).
4. Invite the bot to your server (OAuth2 → URL Generator → `bot` +
   `Send Messages`, `Embed Links`, `Read Message History`).

The user who runs a command must allow **DMs from server members** (or share a
server with the bot) or the confirmation DM can't be delivered.

### Environment (`.env`)

| Key | Description |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Developer Portal. |
| `OWNER_ID` | Owner who gets a DM notification on every `!bandev` (default `1286240448775720962`). |
| `BANDEV_API_URL` | Single-fire ban backend (`?bandev=<UID>`). |
| `BASEINFO_V1_API_URL` | Player-name lookup (`?uid=<UID>`). |

## Deploying

Any Node 18+ host works (Railway, Render, etc.). Set the env vars above. Note that
without a persistent volume, `data/` is wiped on redeploy — so active duration
schedules must be re-run after a redeploy.
