import { BskyAgent, RichText } from "@atproto/api";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import fs from "fs/promises";

const FEED_URL = "https://lewisconnolly.com/feed.xml";
const FEED_ORIGIN = new URL(FEED_URL);
const ALLOWED_HOSTNAME = FEED_ORIGIN.hostname;

const STATE_FILE = "posted-state.json";
const LEGACY_STATE_FILE = "last-posted.txt";
const USER_AGENT = "lewis-bluesky-atom-bot/1.0 (+https://lewisconnolly.com)";
const DEFAULT_BACKFILL_MIN = "2026-01-18T00:00:00Z";
const MAX_GRAPHEMES = 300;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1 * 1024 * 1024;
const MAX_EMBED_TITLE_GRAPHEMES = 300;
const MAX_EMBED_DESC_GRAPHEMES = 1000;

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

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

function decodeBasicHtmlEntities(s) {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function assertArticleUrlAllowed(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error(`Invalid article URL: ${urlString}`);
  }
  if (u.protocol !== "https:") {
    throw new Error("Only https article URLs are allowed.");
  }
  if (u.hostname !== ALLOWED_HOSTNAME) {
    throw new Error(
      `Article host must be ${ALLOWED_HOSTNAME} (from FEED_URL), got ${u.hostname}`
    );
  }
}

function assertImageUrlAllowed(imageUrl, articleUrlString) {
  const article = new URL(articleUrlString);
  const img = new URL(imageUrl, articleUrlString);
  if (img.protocol !== "https:") {
    throw new Error("Only https image URLs are allowed.");
  }
  const ok =
    img.hostname === article.hostname || img.hostname === ALLOWED_HOSTNAME;
  if (!ok) {
    throw new Error(
      `Image host ${img.hostname} does not match article or feed host.`
    );
  }
}

async function fetchWithByteLimit(url, maxBytes, acceptHeader) {
  assertArticleUrlAllowed(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: acceptHeader,
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > maxBytes) {
      throw new Error("Response Content-Length exceeds limit.");
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error("Response body exceeds byte limit.");
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlDocument(articleUrl) {
  const buf = await fetchWithByteLimit(
    articleUrl,
    MAX_HTML_BYTES,
    "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
  );
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function metaContent($, prop) {
  const el = $(`meta[property="${prop}"]`).first();
  let v = el.attr("content");
  if (!v) {
    v = $(`meta[name="${prop}"]`).first().attr("content");
  }
  return v ? decodeBasicHtmlEntities(v.trim()) : "";
}

function parseOpenGraph(html, pageUrl, { titleFallback, descriptionFallback }) {
  const $ = cheerio.load(html);
  let title =
    metaContent($, "og:title") ||
    metaContent($, "twitter:title") ||
    $("title").first().text().trim();
  let description =
    metaContent($, "og:description") ||
    metaContent($, "twitter:description");
  const imageRaw =
    metaContent($, "og:image") ||
    metaContent($, "twitter:image") ||
    metaContent($, "twitter:image:src");

  if (!title) title = titleFallback;
  if (!description) description = descriptionFallback;

  title = normalizeSummaryBody(title);
  description = normalizeSummaryBody(description);
  if (!title) title = "·";
  if (!description) description = "·";

  let imageUrl = null;
  if (imageRaw) {
    try {
      imageUrl = new URL(imageRaw, pageUrl).href;
    } catch {
      imageUrl = null;
    }
  }

  return {
    title: truncateGraphemes(title, MAX_EMBED_TITLE_GRAPHEMES),
    description: truncateGraphemes(description, MAX_EMBED_DESC_GRAPHEMES),
    imageUrl,
  };
}

async function fetchAndUploadThumb(agent, imageUrl, articleUrl) {
  assertImageUrlAllowed(imageUrl, articleUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(imageUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Image HTTP ${res.status}`);
  }
  const cl = res.headers.get("content-length");
  if (cl && Number(cl) > MAX_IMAGE_BYTES) {
    throw new Error("Image Content-Length too large.");
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error("Image body too large.");
  }
  const ctype = (res.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ALLOWED_IMAGE_MIME.has(ctype)) {
    throw new Error(`Unsupported image type: ${ctype || "(missing)"}`);
  }
  const upload = await agent.uploadBlob(buf, { encoding: ctype });
  return upload.data.blob;
}

async function buildExternalEmbed(agent, next) {
  assertArticleUrlAllowed(next.link);
  const html = await fetchHtmlDocument(next.link);
  const og = parseOpenGraph(html, next.link, {
    titleFallback: next.title,
    descriptionFallback: normalizeSummaryBody(next.summary),
  });

  let thumb;
  if (og.imageUrl) {
    try {
      thumb = await fetchAndUploadThumb(agent, og.imageUrl, next.link);
    } catch (err) {
      console.warn("Thumbnail skipped:", err.message || err);
    }
  }

  return {
    $type: "app.bsky.embed.external",
    external: {
      uri: next.link,
      title: og.title,
      description: og.description,
      ...(thumb ? { thumb } : {}),
    },
  };
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
  const dryRunNoFetch =
    process.env.DRY_RUN_NO_FETCH === "1" ||
    /^true$/i.test(process.env.DRY_RUN_NO_FETCH ?? "");

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
    if (dryRunNoFetch) {
      console.log(
        "[DRY_RUN] Link card: skipped HTML fetch (DRY_RUN_NO_FETCH=1)."
      );
      return;
    }
    try {
      const html = await fetchHtmlDocument(next.link);
      const og = parseOpenGraph(html, next.link, {
        titleFallback: next.title,
        descriptionFallback: normalizeSummaryBody(next.summary),
      });
      console.log(
        `[DRY_RUN] Link card: title=${JSON.stringify(og.title.slice(0, 100))}${og.title.length > 100 ? "…" : ""}`
      );
      console.log(
        `[DRY_RUN] Link card: description chars=${og.description.length}, thumb URL=${og.imageUrl ? "yes" : "no"}`
      );
    } catch (err) {
      console.warn("[DRY_RUN] Link card preview failed:", err.message || err);
    }
    return;
  }

  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) {
    throw new Error("Missing BLUESKY_HANDLE or BLUESKY_APP_PASSWORD.");
  }

  const agent = new BskyAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: handle, password });

  const rt = new RichText({ text });
  await rt.detectFacets(agent);
  const postPayload = { text: rt.text };
  if (rt.facets?.length) {
    postPayload.facets = rt.facets;
  }

  postPayload.embed = await buildExternalEmbed(agent, next);

  await agent.post(postPayload);
  postedIds.add(next.id);
  await savePostedIds(postedIds);
  console.log(`Posted: ${next.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
