import fs from "node:fs/promises";

const env = Object.fromEntries(
  (await fs.readFile(".env.local", "utf8"))
    .split("\n")
    .map((line) => line.match(/^([^#=\s]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]])
);

const headers = {
  Authorization: env.WIX_API_KEY,
  "wix-site-id": env.WIX_SITE_ID,
  "Content-Type": "application/json"
};

async function getJson(url) {
  const response = await fetch(url, { headers });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

function collectCandidates(label, payload) {
  const seen = new Map();
  const containers = [
    payload.draftPosts,
    payload.posts,
    payload.items,
    payload.drafts
  ].filter(Array.isArray);

  for (const items of containers) {
    for (const item of items) {
      const memberId = item.memberId || item.owner?.memberId || item.author?.memberId;
      if (memberId && !seen.has(memberId)) {
        seen.set(memberId, {
          source: label,
          memberId,
          title: item.title || item.slug || item.id || "(untitled)"
        });
      }
    }
  }

  return [...seen.values()];
}

const endpoints = [
  ["draft posts", "https://www.wixapis.com/blog/v3/draft-posts"],
  ["published posts", "https://www.wixapis.com/blog/v3/posts"]
];

const all = [];

for (const [label, url] of endpoints) {
  const result = await getJson(url);
  console.log(`\n${label}: HTTP ${result.status}`);
  if (!result.ok) {
    console.log(JSON.stringify(result.payload, null, 2));
    continue;
  }
  const candidates = collectCandidates(label, result.payload);
  all.push(...candidates);
  console.log(JSON.stringify(candidates, null, 2));
}

const unique = [...new Map(all.map((item) => [item.memberId, item])).values()];
console.log("\nunique memberId candidates:");
console.log(JSON.stringify(unique, null, 2));
