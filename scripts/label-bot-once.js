import { BskyAgent } from "@atproto/api";

/**
 * One-time setup: add the official "bot" self-label to the account profile.
 * Run locally with BLUESKY_HANDLE and BLUESKY_APP_PASSWORD set (e.g. in .env via shell).
 * Do not run this on every scheduled workflow.
 */
async function main() {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) {
    throw new Error("Missing BLUESKY_HANDLE or BLUESKY_APP_PASSWORD.");
  }

  const agent = new BskyAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: handle, password });

  await agent.upsertProfile((existing) => ({
    ...existing,
    labels: {
      $type: "com.atproto.label.defs#selfLabels",
      values: [{ val: "bot" }],
    },
  }));

  console.log("Profile updated with bot self-label (com.atproto.label.defs#selfLabels).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
