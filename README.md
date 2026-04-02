# Bluesky Atom feed bot

Scheduled [GitHub Actions](https://docs.github.com/en/actions) workflow that reads the **Atom** feed at [lewisconnolly.com/feed.xml](https://lewisconnolly.com/feed.xml) and posts **at most one** skeet per run to Bluesky.

## What gets posted

- **Body:** `<summary type="text">` from the entry, or the **title** if there is no summary.
- **Then:** two newlines and the article URL (`<link rel="alternate">`).
- **Limit:** the whole post must fit in **300 graphemes** (Bluesky). The URL is always kept intact; the summary is **truncated** at a grapheme boundary (preferring a break at the last space in the second half of the allowed summary span).

Example shape:

```text
Explore how Jungian shadow work explains our emotional projection onto AI. …

https://lewisconnolly.com/2026/04/01/the-synthetic-shadow/
```

The script uses `@atproto/api` **`RichText`** + **`detectFacets`** so the URL is stored as a real **link facet** (clickable in clients). Plain `text` alone is not reliably hyperlinked on Bluesky.

**Link preview cards** (image + title under the post) are a separate **`app.bsky.embed.external`** feature; this bot does not add those unless you extend it to fetch Open Graph metadata and attach an embed.

## Backfill and steady state

- Only entries with **`published` / `updated` ≥ backfill start** are considered. Default start is **`2026-01-18T00:00:00Z`** (UTC), so posting begins with [Condemned to Freedom](https://lewisconnolly.com/2026/01/18/condemned-to-freedom/) and moves forward in time. Override with env **`BACKFILL_MIN_PUBLISHED`** (ISO 8601, e.g. `2026-01-01T00:00:00Z`).
- Among eligible entries, the bot picks the **oldest** whose `<id>` is **not** already in [`posted-state.json`](posted-state.json) (`postedIds` array). That yields **one new post per hourly run** until the backlog is clear, then **only new feed items** as they appear.
- If you publish **two** new posts between runs, the **older** of the two is posted first, then the newer on the next run.

## State file

- **[`posted-state.json`](posted-state.json)** holds `{ "postedIds": [ "…", … ] }`. Actions commits it after each successful post.
- **Legacy:** if `posted-state.json` is missing, the script reads **`last-posted.txt`** (single line = one id) once and migrates to JSON on the next successful write.

## Prerequisites

- A Bluesky account used for posting (often a dedicated bot account).
- An **app password** from Bluesky: **Settings → Privacy and Security → App Passwords**. Never use your main account password in automation.
- A GitHub repository with Actions enabled.

## Repository secrets

In the repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Value |
|--------|--------|
| `BLUESKY_HANDLE` | Your handle, e.g. `yourname.bsky.social` |
| `BLUESKY_APP_PASSWORD` | The app password |

## One-time: label the account as a bot

Bluesky recommends a profile **self-label** `bot` so clients and moderation can recognize automated accounts ([Bots | Bluesky](https://docs.bsky.app/docs/starter-templates/bots)). You only need to do this once.

Locally, with Node dependencies installed:

```bash
export BLUESKY_HANDLE=yourname.bsky.social
export BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
npm run label-bot
```

On Windows (PowerShell):

```powershell
$env:BLUESKY_HANDLE="yourname.bsky.social"
$env:BLUESKY_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
npm run label-bot
```

You can also clarify in the profile bio that posts are automated (e.g. “Essays auto-posted from lewisconnolly.com”).

## Workflow

- **Schedule:** hourly (`cron: "0 * * * *"` UTC). Adjust in [`.github/workflows/post.yml`](.github/workflows/post.yml) if you want a different cadence.
- **Manual run:** **Actions → Post latest Atom entry to Bluesky → Run workflow**.

`npm ci` is used in CI; keep [package-lock.json](package-lock.json) committed.

## Branch protection

If `main` is protected and the default `GITHUB_TOKEN` cannot push, the “Commit state file if changed” step will fail after a successful post. Options: relax rules for `github-actions[bot]`, use a PAT with bypass, or store state elsewhere (e.g. gist).

## Rate limits

Hosted Bluesky limits **`com.atproto.server.createSession`** to **300 logins per day per account** ([Rate limits | Bluesky](https://docs.bsky.app/docs/advanced-guides/rate-limits)). An hourly job is about 24 sessions per day and stays within that budget. If you shorten the interval drastically, consider persisting a session between runs (see Bluesky docs on session management).

## Local testing

Install dependencies, then simulate a post **without** calling Bluesky:

```powershell
$env:DRY_RUN="1"
node post-latest.js
```

To post for real locally, set `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`, and omit `DRY_RUN`.

Optional:

```powershell
$env:BACKFILL_MIN_PUBLISHED="2026-01-18T00:00:00Z"
```

## Behavior notes

- The feed is **Atom** (`<feed>`, `<entry>`), not RSS 2.0 (`<rss>`, `<item>`).
- Entries **not** in the live feed anymore are never posted (feed window limitation).

## References

- [Bots | Bluesky](https://docs.bsky.app/docs/starter-templates/bots)
- [Rate limits | Bluesky](https://docs.bsky.app/docs/advanced-guides/rate-limits)
- [Bluesky cookbook `ts-bot`](https://github.com/bluesky-social/cookbook/tree/main/ts-bot)
