# Discord Bandev Bot

Discord bot for Mini World **`!bandev`** with an **admin approval flow**.

Every ban request is **pending until the admin approves it** — nothing is executed
from the command alone. The admin gets a DM with **Approve / Deny** buttons.

## Features

- `!bandev <UID> [duration]` — **public**, but the ban is **not executed** until
  the admin approves it via DM. Duration example: `1day`, `5m`, `2hours`.
- `!unban <UID>` — stop an active ban.
- `!bandevlist` — list active bans.
- `!help` — show commands.

All output is **English**, and **every message is an embed** (commands, errors,
status, and the approval DM).

**Requests never expire.** The execution data (UID, duration, requester) is
encoded into the button `customId`, so an admin can still Approve/Deny a request
even after the bot restarts or the local `data/` store is wiped. A pending
request just sits in the admin's DM until they decide.

## Approval flow

1. Anyone runs `!bandev 1000 1day`.
2. Bot replies *"…submitted — waiting for admin approval."*
3. Bot **DMs the admin** (user ID `1286240448775720962`) an embed with the
   requester, UID, player name, and duration + **Approve** / **Deny** buttons.
4. Admin clicks **Approve** → the ban executes (and, for a duration, repeats every
   5 minutes until it expires). The DM and the original reply update to *"approved"*.
5. Admin clicks **Deny** → nothing is banned; the DM and reply update to *"denied"*.

Only the admin user ID can press the buttons.

## How duration bans work

Every ban call (the first fire **and** each 5-minute repeat) hits the single-fire
backend `bandev.daxterrantares.workers.dev` (`?bandev=<UID>`). For a duration, the
bot fires once immediately, then a **local scheduler** re-fires every 5 minutes
until the duration ends (e.g. `1day` = repeat every 5 min for 24h, `7days` = for
7 days). No Cloudflare needed.

Caveat: the schedule is kept **in-process** (`data/bans.json`). If the process
restarts / redeploys, active duration schedules are lost (re-issue the ban).
Approval DMs are unaffected — they never expire.

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

### Environment (`.env`)

| Key | Description |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Developer Portal. |
| `ADMIN_USER_ID` | Admin who approves bans (default `1286240448775720962`). |
| `BANDEV_API_URL` | Single-fire ban backend (`?bandev=<UID>`). |
| `BASEINFO_V1_API_URL` | Player-name lookup (`?uid=<UID>`). |

The admin must allow **DMs from server members** (or share a server with the bot)
or the approval DM cannot be delivered.

## Deploying

Any Node 18+ host works (Railway, Render, etc.). Set the env vars above. Note that
without a persistent volume, `data/` is wiped on redeploy — so active duration
schedules are re-issued after a redeploy (approval DMs still work fine).
