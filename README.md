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

The script uses **`RichText`** + **`detectFacets`** so the URL in the body is a real **link facet** (clickable). It also attaches **`app.bsky.embed.external`**: for each post it **GETs the article HTML**, reads Open Graph / Twitter **`meta`** tags (`og:title`, `og:description`, and image fields: `og:image`, `og:image:secure_url`, `og:image:url`, then Twitter image tags, with fallbacks to Atom title/summary), and builds a **link preview card**. If a resolved image URL is **https** and **same-site** with the article or feed hostname—**including `www` vs apex and subdomains** (e.g. `cdn.lewisconnolly.com` for `lewisconnolly.com`)—the image is downloaded (≤8MB by default, jpeg/png/webp/gif) and uploaded via **`com.atproto.repo.uploadBlob`** as the card thumbnail—same pattern as [Website Card Embeds](https://atproto.com/blog/create-post) in the AT Protocol docs. Arbitrary third-party image CDNs on other domains are **not** fetched.

**Network:** each real post does one fetch to the article URL (HTML, ≤2MB, 15s timeout) and optionally one fetch for the preview image. Article URLs must use **`https`** and the hostname from the configured feed URL. Preview images must be **https** and same-site (www-normalized + subdomains of the article or feed host).

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

By default, **`DRY_RUN=1` still fetches** the article HTML to print a short **link-card preview** (title, description length, whether a thumb URL was found). It does **not** log in or upload blobs. To skip those fetches:

```powershell
$env:DRY_RUN="1"
$env:DRY_RUN_NO_FETCH="1"
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

- [Posting via the Bluesky API (embeds)](https://atproto.com/blog/create-post)
- [Bots | Bluesky](https://docs.bsky.app/docs/starter-templates/bots)
- [Rate limits | Bluesky](https://docs.bsky.app/docs/advanced-guides/rate-limits)
- [Bluesky cookbook `ts-bot`](https://github.com/bluesky-social/cookbook/tree/main/ts-bot)
