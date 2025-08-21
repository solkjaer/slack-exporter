# Slack Exporter

Export your own Slack DMs and MPIMs from workspaces. Slack provides export tools for public channels; this CLI helps individuals archive their own private messages.

## Install

```bash
npm install
```

Run with:

```bash
npx slack-exporter --help
```

Or directly:

```bash
node bin/cli.js --help
```

### Command help

Show available and required options:

```bash
slack-exporter --help
```

Or if running directly with Node:

```bash
node bin/cli.js --help
```

## Auth Tokens and Scopes

Use a user token (xoxp-...). Recommended user scopes:

- `im:read`
- `im:history`
- `mpim:read`
- `mpim:history`
- `users:read`
- `groups:read`
- `files:read` (files downloaded by default, use `--skip-files` to skip)
- `emoji:read` (emojis downloaded by default, use `--skip-emojis` to skip)

Set environment variable:

- `SLACK_EXPORT_TOKEN`

Or pass `--token` in the command.

### How to get a user token (xoxp-)

1. Go to the Slack API dashboard: [Create or manage apps](https://api.slack.com/apps).
2. Click "Create New App" → "From scratch" and select the workspace (source or destination).
3. In the left sidebar, open "OAuth & Permissions".
4. Under "User Token Scopes", add the scopes you need: `im:read`, `mpim:read`, `users:read`, `groups:read`, `conversations.history`, `files:read`, `emoji:read`
5. Click "Install to Workspace" (or "Reinstall to Workspace") and approve.
6. Copy the "User OAuth Token" shown at the top (starts with `xoxp-`).

Notes:

- Some workspaces require admin approval for apps/scopes. Request approval if needed.
- Make sure you add scopes under "User Token Scopes" (not just bot scopes), since this tool uses a user token to access your DMs.

### Quick start with a manifest (recommended)

You can create the app with the needed user scopes via Slack's manifest:

1. Open Slack's manifest import: <https://api.slack.com/apps?new_app=1>
2. Choose "From an app manifest" → select your workspace
3. Paste the contents of `manifests/slack-exporter.yaml`
4. Create the app, then go to "OAuth & Permissions" → install, and copy the User OAuth Token (`xoxp-`)

## Usage

```bash
slack-exporter \
  --types im,mpim \
  --since 2022-01-01
```

To skip downloading files, avatars, or emojis (which download by default):
```bash
slack-exporter \
  --types im,mpim \
  --skip-files \
  --skip-avatars \
  --skip-emojis
```

Produces `whoami.json`, `summary.json`, and one JSON per conversation in `./exports/{team-name}/`. Files, avatars, and emojis are downloaded by default and saved under `./exports/{team-name}/files/<conversation>__<id>/`, `./exports/{team-name}/avatars/`, and `./exports/{team-name}/emojis/`. File metadata is automatically included in the JSON when files are downloaded. If your token lacks `files:read`, the exporter will skip downloading files (to avoid saving HTML error pages) and continue exporting messages normally.

When using the GUI (`npm run gui`), avatars and custom emojis are rendered if they exist in the exports directory (downloaded by default unless skipped with `--skip-avatars` or `--skip-emojis`). Some standard emoji shortcodes (e.g., `:joy:`) are rendered as Unicode.

Date filtering with `--since`:

- Accepts dates in format `YYYY-MM-DD`.
- Interpreted in your local timezone at 00:00:00 for that day.
- Filtering is enforced client-side after fetching to avoid server-side edge cases.
- Conversations with zero messages after the cutoff are skipped and not written to disk.

Note: The default output directory is `./exports/{team-name}` (e.g., `./exports/spinner-labs`). You can override it with `--out <dir>`.

## Caveats

- Rate limits apply; use `--concurrency` to tune.
