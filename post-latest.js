import { BskyAgent } from "@atproto/api";
import { XMLParser } from "fast-xml-parser";
import fs from "fs/promises";

const FEED_URL = "https://lewisconnolly.com/feed.xml";
const STATE_FILE = "last-posted.txt";
const USER_AGENT = "lewis-bluesky-atom-bot/1.0 (+https://lewisconnolly.com)";

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

function graphemeLength(s) {
  return [...new Intl.Segmenter({ granularity: "grapheme" }).segment(s)].length;
}

async function fetchNewestEntry() {
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
  entries.sort((a, b) => entryTimeMs(b) - entryTimeMs(a));
  const entry = entries[0];
  const id = atomText(entry.id);
  const title = atomText(entry.title);
  const link = pickEntryUrl(entry);
  return { id, title, link };
}

async function readLastPosted() {
  try {
    return (await fs.readFile(STATE_FILE, "utf8")).trim();
  } catch {
    return "";
  }
}

async function writeLastPosted(id) {
  await fs.writeFile(STATE_FILE, `${id}\n`, "utf8");
}

async function main() {
  const dryRun =
    process.env.DRY_RUN === "1" || /^true$/i.test(process.env.DRY_RUN ?? "");

  const latest = await fetchNewestEntry();
  const lastPosted = await readLastPosted();

  if (!latest.id || !latest.title || !latest.link) {
    throw new Error("Newest entry is missing id, title, or link.");
  }

  if (latest.id === lastPosted) {
    console.log("No new entry to publish.");
    return;
  }

  const text = `${latest.title}\n\nNew on lewisconnolly.com\n${latest.link}`;
  if (graphemeLength(text) > 300) {
    throw new Error(
      "Post text exceeds Bluesky limit (300 graphemes). Shorten title or post template."
    );
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
  await writeLastPosted(latest.id);
  console.log(`Posted: ${latest.title}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
