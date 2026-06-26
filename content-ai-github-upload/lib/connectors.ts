import { ContentDraft } from "./drafts";

export function getConnectorStatus() {
  return {
    wix: {
      configured: Boolean(process.env.WIX_API_KEY && process.env.WIX_SITE_ID),
      needs: ["WIX_API_KEY", "WIX_SITE_ID"].filter((key) => !process.env[key])
    },
    facebook: {
      configured: Boolean(process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_PAGE_ACCESS_TOKEN),
      needs: ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"].filter((key) => !process.env[key])
    }
  };
}

export function makeWixDraftPayload(draft: ContentDraft) {
  return {
    title: draft.title,
    slug: draft.slug,
    excerpt: draft.excerpt || draft.metaDescription,
    seoTitle: draft.seoTitle,
    metaDescription: draft.metaDescription,
    contentMarkdown: draft.body,
    primaryKeyword: draft.primaryKeyword,
    secondaryKeywords: draft.secondaryKeywords,
    faq: draft.faq,
    approvalStatus: draft.approvalStatus
  };
}

export function makeFacebookPayload(draft: ContentDraft) {
  return {
    message: draft.facebookPost,
    link: `https://www.southtowndentaltoowoomba.com.au/blog/${draft.slug}`
  };
}

export async function publishFacebookPost(draft: ContentDraft) {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  if (!pageId || !token) {
    return {
      ok: false,
      status: "Needs credentials" as const,
      message: "Facebook Page ID and Page access token are not configured."
    };
  }

  const payload = makeFacebookPayload(draft);
  const body = new URLSearchParams({
    message: payload.message,
    link: payload.link,
    access_token: token
  });

  const response = await fetch(`https://graph.facebook.com/v20.0/${pageId}/feed`, {
    method: "POST",
    body
  });
  const result = await response.json();

  if (!response.ok) {
    return {
      ok: false,
      status: "Error" as const,
      message: result.error?.message || "Facebook rejected the post.",
      result
    };
  }

  return {
    ok: true,
    status: "Published" as const,
    message: "Facebook post published.",
    result
  };
}
