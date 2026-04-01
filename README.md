# Bluesky Atom feed bot

Scheduled [GitHub Actions](https://docs.github.com/en/actions) workflow that reads the **Atom** feed at [lewisconnolly.com/feed.xml](https://lewisconnolly.com/feed.xml), compares the newest entry to the last one posted, and publishes a short skeet to Bluesky when there is something new.

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

## First run and `last-posted.txt`

- If **`last-posted.txt` is missing** (or empty), the next successful run will post the **current newest** feed entry—even if you already shared it manually on Bluesky.
- To avoid that duplicate, **seed** the file before the first workflow run: create `last-posted.txt` with a single line containing that entry’s Atom `<id>` (the permalink URL is usually the same as `id` on your site), commit, and push.
- After each new post, Actions commits an updated `last-posted.txt` to the repo.

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

## Behavior notes

- The feed is **Atom** (`<feed>`, `<entry>`), not RSS 2.0 (`<rss>`, `<item>`).
- Entries are sorted by **`published` / `updated`**; the newest wins (not raw XML order).
- Only the **single newest** entry is considered each run. If you publish **two** new posts between runs, **one may be skipped** until you extend the bot to track multiple IDs or timestamps.
- Post body must stay within Bluesky’s **300 grapheme** limit; very long titles can cause the script to exit with an error until you shorten the template or title.

## References

- [Bots | Bluesky](https://docs.bsky.app/docs/starter-templates/bots)
- [Rate limits | Bluesky](https://docs.bsky.app/docs/advanced-guides/rate-limits)
- [Bluesky cookbook `ts-bot`](https://github.com/bluesky-social/cookbook/tree/main/ts-bot)
