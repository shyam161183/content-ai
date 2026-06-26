import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { ContentDraft, SavedContentDraft } from "./drafts";

const dataDir = path.join(process.cwd(), "data");
const draftsPath = path.join(dataDir, "drafts.json");

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(draftsPath);
  } catch {
    await fs.writeFile(draftsPath, "[]\n", "utf8");
  }
}

export async function listDrafts(): Promise<SavedContentDraft[]> {
  await ensureStore();

  const raw = await fs.readFile(draftsPath, "utf8");
  const parsed = JSON.parse(raw) as SavedContentDraft[];

  return parsed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveDraft(draft: ContentDraft): Promise<SavedContentDraft> {
  await ensureStore();

  const drafts = await listDrafts();
  const now = new Date().toISOString();
  const id = draft.id || randomUUID();
  const existing = drafts.find((item) => item.id === id);
  const saved: SavedContentDraft = {
    ...draft,
    id,
    createdAt: existing?.createdAt || draft.createdAt || now,
    updatedAt: now
  };
  const next = [saved, ...drafts.filter((item) => item.id !== id)];

  await fs.writeFile(draftsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return saved;
}

export function draftToMarkdown(draft: ContentDraft) {
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(draft.title)}`,
    `seoTitle: ${JSON.stringify(draft.seoTitle)}`,
    `metaDescription: ${JSON.stringify(draft.metaDescription)}`,
    `slug: ${JSON.stringify(draft.slug)}`,
    `primaryKeyword: ${JSON.stringify(draft.primaryKeyword)}`,
    `approvalStatus: ${JSON.stringify(draft.approvalStatus)}`,
    "---"
  ].join("\n");
  const faq = draft.faq
    .map((item) => `### ${item.question}\n\n${item.answer}`)
    .join("\n\n");
  const facebook = `## Facebook Post\n\n${draft.facebookPost}`;
  const safety = `## Safety Notes\n\n${draft.safetyNotes.map((note) => `- ${note}`).join("\n")}`;

  return [frontmatter, draft.body, "## FAQ", faq, facebook, safety].join("\n\n");
}
