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

All output is **English**.

## Approval flow

1. Anyone runs `!bandev 1000 1day`.
2. Bot replies *"…submitted — waiting for admin approval."*
3. Bot **DMs the admin** (user ID `1286240448775720962`) an embed with the
   requester, UID, player name, and duration + **Approve** / **Deny** buttons.
4. Admin clicks **Approve** → the ban executes (and, for a duration, repeats every
   5 minutes until it expires). The DM and the original reply update to *"approved"*.
5. Admin clicks **Deny** → nothing is banned; the DM and reply update to *"denied"*.

Only the admin user ID can press the buttons.

## Duration bans & restarts

If `BANDEV_LOOP_API_URL` is set (Cloudflare loop worker — see
`worker-bandev-loop.js` in the WA bot repo), duration repeats live in
**Cloudflare KV + Cron** and survive restarts.

If it is **not** set, the bot falls back to a **local scheduler** (a `setInterval`).
That loses the schedule whenever the process restarts / redeploys — so set the
loop URL for reliable duration bans.

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
| `BANDEV_API_URL` | Single-fire ban worker (`?bandev=<UID>`). |
| `BANDEV_LOOP_API_URL` | Optional Cloudflare loop worker (`?uid=&bantime=`). Leave empty for local fallback. |
| `BASEINFO_V1_API_URL` | Player-name lookup (`?uid=<UID>`). |

The admin must allow **DMs from server members** (or share a server with the bot)
or the approval DM cannot be delivered.

## Deploying

Any Node 18+ host works (Railway, Render, etc.). Set the env vars above. Note that
without a persistent volume, `data/` is wiped on redeploy — which is another reason
to configure `BANDEV_LOOP_API_URL`.
