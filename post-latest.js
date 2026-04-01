import { BskyAgent } from "@atproto/api";
import { XMLParser } from "fast-xml-parser";
import fs from "fs/promises";

const FEED_URL = "https://lewisconnolly.com/feed.xml";
const STATE_FILE = "posted-state.json";
const LEGACY_STATE_FILE = "last-posted.txt";
const USER_AGENT = "lewis-bluesky-atom-bot/1.0 (+https://lewisconnolly.com)";
const DEFAULT_BACKFILL_MIN = "2026-01-18T00:00:00Z";
const MAX_GRAPHEMES = 300;

function backfillMinMs() {
  const raw = process.env.BACKFILL_MIN_PUBLISHED?.trim() || DEFAULT_BACKFILL_MIN;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) {
    throw new Error(
      `Invalid BACKFILL_MIN_PUBLISHED="${raw}". Use an ISO 8601 date (default ${DEFAULT_BACKFILL_MIN}).`
    );
  }
  return t;
}

function atomText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node.trim();
  if (typeof node === "object" && typeof node["#text"] === "string") {
    return node["#text"].trim();
  }
  return String(node).trim();
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function entryTimeMs(entry) {
  const raw = entry.published ?? entry.updated;
  const s = atomText(raw);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function pickEntryUrl(entry) {
  const links = asArray(entry.link);
  const withHref = links.filter((l) => l && (l["@_href"] || l.href));
  const alternate = withHref.find(
    (l) => (l["@_rel"] ?? l.rel ?? "alternate") === "alternate"
  );
  const chosen = alternate ?? withHref[0];
  if (!chosen) return "";
  const href = chosen["@_href"] ?? chosen.href;
  return typeof href === "string" ? href.trim() : "";
}

function normalizeAtomEntries(parsed) {
  const feed = parsed?.feed;
  if (!feed) {
    throw new Error("Not an Atom feed: missing <feed> root.");
  }
  return asArray(feed.entry);
}

function graphemeSegments(s) {
  return [
    ...new Intl.Segmenter({ granularity: "grapheme" }).segment(s),
  ].map((seg) => seg.segment);
}

function graphemeLength(s) {
  return graphemeSegments(s).length;
}

/** Truncate to at most max grapheme clusters; prefer breaking at the last space in the second half. */
function truncateGraphemes(s, max) {
  if (max <= 0) return "";
  const segs = graphemeSegments(s);
  if (segs.length <= max) return s;
  let out = segs.slice(0, max).join("");
  const lastSpace = out.lastIndexOf(" ");
  if (lastSpace > 0 && lastSpace > Math.floor(max * 0.5)) {
    out = out.slice(0, lastSpace).trimEnd();
  }
  return out;
}

function normalizeSummaryBody(s) {
  return s.replace(/\s+/g, " ").trim();
}

function buildPostText(summary, url) {
  const body = normalizeSummaryBody(summary);
  const tail = `\n\n${url}`;
  const tailLen = graphemeLength(tail);
  if (tailLen > MAX_GRAPHEMES) {
    throw new Error(
      `URL plus separators exceed ${MAX_GRAPHEMES} graphemes; shorten the URL or raise the limit in code.`
    );
  }
  const maxSummary = MAX_GRAPHEMES - tailLen;
  const truncated =
    graphemeLength(body) <= maxSummary ? body : truncateGraphemes(body, maxSummary);
  return `${truncated}${tail}`;
}

async function loadPostedIds() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.postedIds)) {
      throw new Error("posted-state.json must contain a postedIds array.");
    }
    return new Set(
      data.postedIds.map((x) => String(x).trim()).filter(Boolean)
    );
  } catch (e) {
    if (e.code !== "ENOENT") {
      if (e instanceof SyntaxError) {
        throw new Error(`Invalid posted-state.json: ${e.message}`);
      }
      throw e;
    }
  }
  try {
    const legacy = (await fs.readFile(LEGACY_STATE_FILE, "utf8")).trim();
    if (legacy) {
      return new Set([legacy]);
    }
  } catch {
    /* no legacy file */
  }
  return new Set();
}

async function savePostedIds(postedIds) {
  const postedIdsArray = [...postedIds].sort();
  await fs.writeFile(
    STATE_FILE,
    `${JSON.stringify({ postedIds: postedIdsArray }, null, 2)}\n`,
    "utf8"
  );
}

async function fetchEligibleEntries(minMs) {
  const res = await fetch(FEED_URL, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch feed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const parsed = parser.parse(xml);
  const entries = normalizeAtomEntries(parsed);
  if (entries.length === 0) {
    throw new Error("No Atom entries found.");
  }
  return entries
    .map((entry) => {
      const id = atomText(entry.id);
      const title = atomText(entry.title);
      const link = pickEntryUrl(entry);
      const summaryRaw = atomText(entry.summary);
      const summary = summaryRaw || title;
      const t = entryTimeMs(entry);
      return { entry, id, title, link, summary, t };
    })
    .filter((e) => e.t >= minMs && e.id && e.link && e.summary)
    .sort((a, b) => a.t - b.t);
}

function pickNextToPost(eligible, postedIds) {
  for (const e of eligible) {
    if (!postedIds.has(e.id)) {
      return e;
    }
  }
  return null;
}

async function main() {
  const dryRun =
    process.env.DRY_RUN === "1" || /^true$/i.test(process.env.DRY_RUN ?? "");

  const minMs = backfillMinMs();
  const postedIds = await loadPostedIds();
  const eligible = await fetchEligibleEntries(minMs);
  const next = pickNextToPost(eligible, postedIds);

  if (!next) {
    console.log("No new entry to publish.");
    return;
  }

  const text = buildPostText(next.summary, next.link);
  if (graphemeLength(text) > MAX_GRAPHEMES) {
    throw new Error(`Post still exceeds ${MAX_GRAPHEMES} graphemes after truncation.`);
  }

  if (dryRun) {
    console.log("[DRY_RUN] Would post:\n---\n" + text + "\n---");
    return;
  }

  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) {
    throw new Error("Missing BLUESKY_HANDLE or BLUESKY_APP_PASSWORD.");
  }

  const agent = new BskyAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: handle, password });
  await agent.post({ text });
  postedIds.add(next.id);
  await savePostedIds(postedIds);
  console.log(`Posted: ${next.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
