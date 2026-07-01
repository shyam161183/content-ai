// deployment marker: shared-gsc-v3
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = process.cwd();
const env = { ...(await loadEnv(path.join(root, ".env.local"))), ...process.env };
const port = Number(env.PORT || 3000);
const dataRoot = env.VERCEL ? "/tmp/southtown-content-agent" : path.join(root, "data");
const draftsPath = path.join(dataRoot, "drafts.json");
const historyPath = path.join(dataRoot, "publish-history.json");
const generatedImagesPath = path.join(dataRoot, "generated-images");
const googleTokensKey = "google_search_console_tokens";

async function loadEnv(file) {
  const out = {};
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, body) {
  send(res, status, JSON.stringify(body), { "Content-Type": "application/json" });
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((item) => {
    const [key, ...value] = item.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

function supabaseConfigured() {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

function supabaseRestUrl(pathname) {
  return `${String(env.SUPABASE_URL || "").replace(/\/+$/, "")}/rest/v1/${pathname}`;
}

async function getSetting(key) {
  if (!supabaseConfigured()) return null;

  const response = await fetch(supabaseRestUrl(`content_ai_settings?key=eq.${encodeURIComponent(key)}&select=value`), {
    headers: supabaseHeaders()
  });

  if (!response.ok) {
    throw new Error(`Supabase setting lookup failed: ${response.status}`);
  }

  const rows = await response.json().catch(() => []);
  return rows[0]?.value || null;
}

async function saveSetting(key, value) {
  if (!supabaseConfigured()) return null;

  const response = await fetch(supabaseRestUrl("content_ai_settings?on_conflict=key"), {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify({
      key,
      value,
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Supabase setting save failed: ${response.status} ${detail}`);
  }

  return response.json().catch(() => null);
}

function cookieGoogleTokens(req) {
  const encoded = parseCookies(req).google_tokens;
  if (!encoded) return null;

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function storedGoogleTokens(req) {
  return cookieGoogleTokens(req) || await getSetting(googleTokensKey);
}

async function hasGoogleTokens(req) {
  return Boolean(await storedGoogleTokens(req).catch(() => null));
}

async function saveGoogleTokens(tokens) {
  if (!supabaseConfigured()) {
    throw new Error("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  const existing = await getSetting(googleTokensKey).catch(() => null);
  const merged = {
    ...(existing || {}),
    ...(tokens || {})
  };

  if (!merged.refresh_token && existing?.refresh_token) {
    merged.refresh_token = existing.refresh_token;
  }

  await saveSetting(googleTokensKey, merged);
  return merged;
}

async function connectorStatus(req) {
  const cookieTokens = cookieGoogleTokens(req);
  const status = {
    gsc: {
      cookieConnected: Boolean(cookieTokens),
      sharedConnected: false,
      supabaseConfigured: supabaseConfigured(),
      status: "Not connected",
      error: ""
    },
    wix: {
      configured: Boolean(env.WIX_API_KEY && env.WIX_SITE_ID && env.WIX_MEMBER_ID),
      needs: ["WIX_API_KEY", "WIX_SITE_ID", "WIX_MEMBER_ID"].filter((key) => !env[key])
    },
    facebook: {
      configured: Boolean(env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_ACCESS_TOKEN),
      needs: ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"].filter((key) => !env[key])
    }
  };

  try {
    const sharedTokens = await getSetting(googleTokensKey);
    status.gsc.sharedConnected = Boolean(sharedTokens?.refresh_token || sharedTokens?.access_token);
    status.gsc.status = status.gsc.sharedConnected
      ? "Shared workspace connection is saved"
      : status.gsc.cookieConnected
        ? "Connected only in this browser"
        : "Not connected";
  } catch (error) {
    status.gsc.status = status.gsc.cookieConnected ? "Connected only in this browser" : "Not connected";
    status.gsc.error = error.message;
  }

  return status;
}

let googleApi;

async function getGoogle() {
  if (!googleApi) {
    googleApi = (await import("googleapis")).google;
  }
  return googleApi;
}

async function oauthClient() {
  const google = await getGoogle();
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );
}

function score(rows) {
  return rows.map((row) => {
    const ctrPercent = row.ctr * 100;
    const nearPageOne = row.position >= 5 && row.position <= 20;
    const lowCtr = row.impressions >= 20 && ctrPercent < 3;
    const cluster = row.impressions >= 10 && row.clicks <= 2;
    const type = lowCtr ? "CTR lift" : nearPageOne ? "Near page one" : "Content cluster";
    const contentType = recommendedContentType(row.query, type);
    const priority = priorityForRow(row, type);
    const keywordPlan = buildKeywordPlan(row, rows, type, priority, contentType);
    return {
      ...row,
      score: row.impressions * 0.6 + Math.max(0, 25 - row.position) * 8 + (lowCtr ? 80 : 0) + (nearPageOne ? 60 : 0) + (cluster ? 30 : 0),
      type,
      priority,
      cluster: clusterLabel(row.query),
      contentType,
      keywordPlan,
      draftAngle: type === "CTR lift"
        ? `Refresh or create a clear local answer around "${titleCase(row.query)}" with a stronger title, meta description, and patient-focused FAQ section.`
        : `Create a practical Toowoomba-focused guide for "${titleCase(row.query)}".`
    };
  }).sort((a, b) => b.score - a.score).slice(0, 20);
}

function titleCase(value) {
  return value.split(" ").filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
}

function clusterLabel(query) {
  const q = String(query || "").toLowerCase();
  if (/\bimplant|implants\b/.test(q)) return "Implants";
  if (/\bgum|gums|oral health|bleeding\b/.test(q)) return "Gums & oral health";
  if (/\bemergency|pain|ache|urgent|broken|swelling\b/.test(q)) return "Emergency intent";
  if (/\bnewtown|south town|southtown|toowoomba\b/.test(q)) return "Local/suburb";
  if (/\bnear me|clinic|dentist|dental\b/.test(q)) return "Dentist discovery";
  if (/\bprice|cost|quote|fees?\b/.test(q)) return "Cost research";
  if (/\bchild|kids|family\b/.test(q)) return "Family dentistry";
  return "General dental";
}

function recommendedContentType(query, type) {
  const q = String(query || "").toLowerCase();
  if (type === "CTR lift") return "Refresh snippet/page";
  if (/\bnear me|clinic|dentist|toowoomba|newtown|southtown\b/.test(q)) return "Local guide";
  if (/\bprice|cost|quote|fees?\b/.test(q)) return "FAQ article";
  if (/\bemergency|pain|ache|urgent|broken|swelling\b/.test(q)) return "Service/FAQ page";
  return "Blog article";
}

function priorityForRow(row, type) {
  const ctrPercent = row.ctr * 100;
  if (row.impressions >= 100 && (ctrPercent < 2.5 || row.position <= 12)) return "High";
  if (type === "Near page one" || row.impressions >= 40) return "Medium";
  return "Low";
}

function searchIntent(query) {
  const q = String(query || "").toLowerCase();
  if (/\bnear me|book|appointment|clinic|dentist toowoomba|dentist newtown\b/.test(q)) return "Transactional/local";
  if (/\bcost|price|quote|fees?|best|compare\b/.test(q)) return "Commercial";
  if (/\bwhat|why|how|guide|symptom|sign|care|healthy|maintain\b/.test(q)) return "Informational";
  if (/\bsouthtown|oral experts|brand|login\b/.test(q)) return "Navigational";
  return "Informational";
}

function funnelStage(intent) {
  if (intent === "Transactional/local") return "Bottom funnel";
  if (intent === "Commercial") return "Middle funnel";
  if (intent === "Navigational") return "Existing demand";
  return "Top funnel";
}

function targetCtrForPosition(position) {
  if (position <= 3) return 0.09;
  if (position <= 10) return 0.05;
  if (position <= 20) return 0.025;
  return 0.012;
}

function uniqueKeywords(items) {
  const seen = new Set();
  return items.map((item) => String(item || "").toLowerCase().trim()).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function buildKeywordPlan(row, rows, type, priority, contentType) {
  const primary = String(row.query || "").toLowerCase().trim();
  const cluster = clusterLabel(primary);
  const topic = titleCase(primary);
  const related = rows
    .filter((item) => item.query && item.query.toLowerCase() !== primary && clusterLabel(item.query) === cluster)
    .sort((a, b) => b.impressions - a.impressions)
    .map((item) => item.query);
  const supporting = uniqueKeywords(related).slice(0, 5);
  const optional = uniqueKeywords([
    ...supporting.slice(3),
    "Toowoomba dentist",
    "Southtown Dental Toowoomba",
    "dental care Toowoomba"
  ]).filter((item) => item !== primary).slice(0, 6);
  const mandatory = uniqueKeywords([primary, ...supporting.slice(0, 3)]).slice(0, 4);
  const intent = searchIntent(primary);
  const targetCtr = targetCtrForPosition(row.position);
  const estimatedClicks = Math.max(0, Math.round(row.impressions * targetCtr - row.clicks));
  const density = {
    primary: "0.6-1.0%",
    exactPhraseMentions: row.impressions >= 100 ? "3-5" : "2-3",
    supportingMentions: "1-2 each",
    note: "Use naturally; avoid keyword stuffing, especially for medical/dental content."
  };

  return {
    primaryKeyword: primary,
    mandatoryKeywords: mandatory,
    optionalKeywords: optional,
    searchIntent: intent,
    funnelStage: funnelStage(intent),
    contentType,
    density,
    titleOptions: [
      `${topic} in Toowoomba: What Patients Should Know`,
      `A Local Guide to ${topic} in Toowoomba`,
      `${topic}: Questions Toowoomba Patients Often Ask`,
      `When to Ask a Toowoomba Dentist About ${topic}`,
      `${topic} Guide for Toowoomba Families`
    ],
    topicsToCover: [
      "What patients usually want to know",
      "What a dentist may check",
      "When to book an appointment",
      "Local dental care in Toowoomba"
    ],
    forbiddenWords: ["revolutionary", "guaranteed", "best", "painless", "permanent"],
    tone: "Professional, calm, patient-friendly",
    readingLevel: "Grade 8-10",
    estimatedUpside: {
      targetCtr,
      additionalClicks: estimatedClicks,
      basis: `If CTR improves toward ${(targetCtr * 100).toFixed(1)}% for this position band over the selected date range.`
    },
    brief: [
      `${priority} priority ${type.toLowerCase()} opportunity.`,
      `Intent: ${intent}; recommended format: ${contentType}.`,
      `Include mandatory keywords naturally: ${mandatory.join(", ")}.`,
      estimatedClicks > 0 ? `Potential upside: about ${estimatedClicks} extra clicks in a similar period if CTR improves.` : "Potential upside is mainly content coverage and authority, not immediate click lift."
    ].join(" ")
  };
}

function buildInsights(rows, opportunities, dateRows) {
  const totals = {
    rows: rows.length,
    clicks: rows.reduce((a, b) => a + b.clicks, 0),
    impressions: rows.reduce((a, b) => a + b.impressions, 0),
    averagePosition: rows.reduce((a, b) => a + b.position, 0) / Math.max(rows.length, 1)
  };
  totals.ctr = totals.clicks / Math.max(totals.impressions, 1);

  const clusterMap = new Map();
  const positionBuckets = [
    { label: "1-3", count: 0, impressions: 0 },
    { label: "4-10", count: 0, impressions: 0 },
    { label: "11-20", count: 0, impressions: 0 },
    { label: "21+", count: 0, impressions: 0 }
  ];

  for (const row of rows) {
    const label = clusterLabel(row.query);
    const existing = clusterMap.get(label) || { label, queries: 0, clicks: 0, impressions: 0, weightedPosition: 0 };
    existing.queries += 1;
    existing.clicks += row.clicks;
    existing.impressions += row.impressions;
    existing.weightedPosition += row.position * Math.max(row.impressions, 1);
    clusterMap.set(label, existing);

    const bucket = row.position <= 3 ? positionBuckets[0] : row.position <= 10 ? positionBuckets[1] : row.position <= 20 ? positionBuckets[2] : positionBuckets[3];
    bucket.count += 1;
    bucket.impressions += row.impressions;
  }

  const clusters = [...clusterMap.values()].map((item) => ({
    ...item,
    ctr: item.clicks / Math.max(item.impressions, 1),
    averagePosition: item.weightedPosition / Math.max(item.impressions, 1)
  })).sort((a, b) => b.impressions - a.impressions).slice(0, 8);

  const priorityCounts = ["High", "Medium", "Low"].map((label) => ({
    label,
    count: opportunities.filter((item) => item.priority === label).length
  }));

  const ctrGaps = opportunities
    .filter((item) => item.impressions >= 20 && item.ctr < 0.03)
    .slice(0, 8)
    .map((item) => ({
      query: item.query,
      impressions: item.impressions,
      ctr: item.ctr,
      position: item.position,
      priority: item.priority
    }));

  const topQueries = [...rows]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 8)
    .map((item) => ({
      query: item.query,
      impressions: item.impressions,
      clicks: item.clicks,
      ctr: item.ctr,
      position: item.position,
      cluster: clusterLabel(item.query)
    }));

  const trend = dateRows.map((row) => ({
    date: row.date,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.clicks / Math.max(row.impressions, 1),
    position: row.position
  }));

  return {
    totals,
    status: {
      queryCount: rows.length,
      contentOpportunities: opportunities.length,
      ctrLift: opportunities.filter((item) => item.type === "CTR lift").length,
      nearPageOne: opportunities.filter((item) => item.type === "Near page one").length
    },
    priorityCounts,
    clusters,
    positionBuckets,
    ctrGaps,
    topQueries,
    trend
  };
}

function templateDraft(opportunity) {
  const topic = titleCase(opportunity.query);
  const keywordPlan = opportunity.keywordPlan || buildKeywordPlan(opportunity, [opportunity], opportunity.type || "Content cluster", opportunity.priority || "Medium", opportunity.contentType || "Blog article");
  const title = keywordPlan.selectedTitle || keywordPlan.titleOptions?.[0] || `${topic} in Toowoomba: What Patients Should Know`;
  const supportingKeywords = keywordPlan.mandatoryKeywords?.filter((item) => item !== keywordPlan.primaryKeyword) || [];
  const body = [
    `Many people search for "${opportunity.query}" when they are trying to understand what to do next. This guide gives Toowoomba patients a practical starting point without replacing personalised advice from a dentist who can examine their teeth and gums.`,
    "",
    "For Southtown Dental Toowoomba, the aim of this article is to answer the first questions a patient may have, explain when professional care is sensible, and give clear next steps in plain language. It should help people feel informed before they book, while making it clear that online information cannot diagnose a dental problem.",
    "",
    "## Why this topic matters",
    "",
    `Search Console shows this topic has ${opportunity.impressions} impressions and an average position of ${opportunity.position.toFixed(1)} in the selected date range. That means people are already looking for this information, but the current content may need a clearer, more helpful answer.`,
    "",
    keywordPlan.estimatedUpside?.additionalClicks
      ? `If this topic improves toward the expected CTR for its current position band, it could add around ${keywordPlan.estimatedUpside.additionalClicks} extra clicks in a similar date range. This is an estimate, not a guarantee, but it helps explain why the topic is worth prioritising.`
      : "The main value of this topic is coverage: it helps answer a relevant patient question and supports the broader local dental content cluster.",
    "",
    "For patients, the goal is usually simple: understand what is normal, what may need attention, and when it is sensible to book an appointment. Good dental content should reduce confusion without creating alarm.",
    "",
    "Local search behaviour also gives the clinic a useful clue. If people in and around Toowoomba are already searching for this topic, a stronger article can meet that demand with practical, location-aware information. That can support SEO while also improving the patient experience before someone contacts the clinic.",
    "",
    "## Common signs and questions patients may have",
    "",
    "Patients often want to know whether a symptom is minor, whether it can wait, or whether it needs a dental visit. Changes such as bleeding gums, sensitivity, discomfort, swelling, persistent bad breath, chipped teeth, or changes around existing dental work are worth discussing with a dentist.",
    "",
    keywordPlan.topicsToCover?.length
      ? `This article is planned to cover: ${keywordPlan.topicsToCover.join(", ")}. These points help keep the content focused on useful patient questions rather than simply repeating keywords.`
      : "This article is planned around practical patient questions rather than simply repeating keywords.",
    "",
    "It is also common for patients to search before booking because they want to know what might happen at the appointment. A helpful article should explain the process in plain language and make the next step feel clear.",
    "",
    "Some patients may also be comparing whether they need a routine check-up, hygiene appointment, or more urgent dental advice. The safest answer is that a dentist needs to examine the mouth before recommending treatment. However, an article can still explain the kinds of information a dental team may consider.",
    "",
    "## What a dentist may check",
    "",
    "At an appointment, the dental team may ask about symptoms, medical history, oral hygiene routines, diet, previous treatment, and any concerns. The dentist can examine the teeth, gums, bite, and soft tissues, then explain whether monitoring, hygiene support, preventive care, or treatment may be appropriate.",
    "",
    "This kind of assessment is important because two people can search for the same dental topic but need different advice. Age, oral health history, medications, habits, and symptoms can all affect what is recommended.",
    "",
    "Where appropriate, the dentist may also discuss preventive options, oral hygiene technique, diet, existing restorations, gum health, or whether further investigation is needed. The value of a local appointment is that the advice can be matched to the individual patient rather than based on a general online description.",
    "",
    "## Questions worth asking at your appointment",
    "",
    "Patients can make the most of a visit by bringing clear questions. Useful questions include: what may be contributing to the concern, what can be monitored at home, what warning signs should prompt a faster appointment, and what daily habits may reduce future risk.",
    "",
    "It can also help to mention when the issue started, whether it has changed, whether anything makes it better or worse, and whether there is pain, bleeding, swelling, sensitivity, or difficulty eating. Small details can help the dental team understand the bigger picture.",
    "",
    "## Simple steps patients can take at home",
    "",
    "A good home routine can support oral health between appointments. Most patients benefit from brushing twice daily with fluoride toothpaste, cleaning between the teeth, drinking plenty of water, and limiting frequent sugary snacks and drinks.",
    "",
    "These steps are general and may not suit every situation. If symptoms continue, change suddenly, or cause concern, it is better to book a dental appointment than rely only on online information.",
    "",
    "Patients should also be careful with quick fixes found online. Some home remedies can irritate teeth or gums, delay proper care, or make symptoms harder to assess. A simple, consistent routine and timely professional advice are usually more useful than trying multiple unverified approaches.",
    "",
    "## When to book sooner",
    "",
    "Patients should consider booking promptly if they notice dental pain, swelling, bleeding that does not settle, a broken tooth, trauma, signs of infection, or any sudden change that worries them. Early advice can make the situation easier to understand and manage.",
    "",
    "For parents, carers, older adults, or patients with medical conditions, it can be especially important to ask for advice rather than waiting too long. The dental team can help decide whether the matter is routine, should be seen soon, or requires more urgent attention.",
    "",
    "## Local dental care in Toowoomba",
    "",
    "For Toowoomba families, having a local dental team can make regular check-ups and follow-up care easier to manage. Southtown Dental Toowoomba can help patients understand their options after an examination and discuss next steps based on their individual needs.",
    "",
    supportingKeywords.length
      ? `This guide also connects related search themes such as ${supportingKeywords.join(", ")} so patients can find one clear local explanation rather than separate, thin answers.`
      : "This guide is written to connect the patient question with practical local dental care in Toowoomba.",
    "",
    "A local clinic also makes it easier to build continuity of care. When a dental team understands a patient's history, previous treatment, comfort level, and goals, advice can be more practical over time. That relationship can be useful for preventive care, routine reviews, and conversations about any future treatment options.",
    "",
    "## Key takeaway for patients",
    "",
    `If you searched for "${opportunity.query}", the most useful next step is to treat this article as a starting point. Use it to understand the common considerations, then book a dental appointment if you have symptoms, uncertainty, or would like advice that is specific to your mouth.`,
    "",
    "Good dental care is personal. A clear article can explain the topic, but an examination is what allows a dentist to give advice based on what is actually happening.",
    "",
    "## General information only",
    "",
    "This article is general information only and should not be used as a diagnosis or treatment plan. For personal advice, patients should book an appointment with a qualified dental professional."
  ].join("\n");
  return {
    title,
    seoTitle: `${titleCase(keywordPlan.primaryKeyword || opportunity.query)} in Toowoomba | Southtown Dental`,
    metaDescription: `A simple Toowoomba patient guide for ${opportunity.query}. General information only; book a dental appointment for personal advice.`,
    slug: slugify(`${opportunity.query}-toowoomba-guide`),
    excerpt: `A simple Toowoomba patient guide for ${opportunity.query}.`,
    heroImageUrl: "",
    heroImageAlt: `${topic} dental care in Toowoomba`,
    heroImageAspectRatio: "16:9",
    primaryKeyword: opportunity.query,
    secondaryKeywords: keywordPlan.mandatoryKeywords?.filter((item) => item !== keywordPlan.primaryKeyword).concat(keywordPlan.optionalKeywords || []).slice(0, 8) || ["Toowoomba dentist", "Southtown Dental Toowoomba", "dental care Toowoomba"],
    keywordPlan,
    outline: ["Why this topic matters", "Common signs and questions patients may have", "What a dentist may check", "Simple steps patients can take at home", "When to book sooner", "Local dental care in Toowoomba", "General information only"],
    body,
    faq: [
      { question: `Should I ask a dentist about "${opportunity.query}"?`, answer: "Yes, if you have symptoms, concerns, or changes in your mouth." },
      { question: "Can this article diagnose my dental problem?", answer: "No. Diagnosis requires an appointment with a qualified dental professional." },
      { question: "How often should I book a dental check-up?", answer: "The right timing depends on your oral health, risk factors, and dentist's advice. Many patients benefit from regular check-ups and professional cleans." }
    ],
    facebookPost: `New local guide draft: ${title}\n\nGeneral information only. For dental concerns, contact Southtown Dental Toowoomba.`,
    safetyNotes: ["Keep this as general health information, not diagnosis.", "Avoid promises or guarantees.", "Do not imply treatment suitability before an examination."],
    approvalStatus: "Ready for review",
    publishStatus: { wix: "Not sent", facebook: "Not sent" },
    generationSource: "Template"
  };
}

async function generateDraft(opportunity) {
  const fallback = templateDraft(opportunity);

  if (!env.OPENAI_API_KEY) {
    return fallback;
  }

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.OPENAI_TIMEOUT_MS || 20000));

  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4o-mini",
        input: [
          {
            role: "developer",
            content: [
              "You are a cautious dental content strategist for an Australian dental clinic.",
              "Create useful, patient-friendly SEO blog content for Southtown Dental Toowoomba.",
              "Do not diagnose, guarantee outcomes, make treatment claims, or create urgency beyond common-sense dental safety advice.",
              "Return JSON only. Required keys: title, seoTitle, metaDescription, slug, excerpt, heroImageAlt, outline, body, faq, facebookPost, safetyNotes.",
              "The body must be 900 to 1200 words, must not start with an H1 or repeat the title, and must use markdown H2 headings.",
              "The body should have a short intro, practical sections, local Toowoomba relevance, clear next steps, and a general information disclaimer.",
              "Use the provided keywordPlan to shape the article. Include mandatory keywords naturally, respect density guidance, and do not stuff keywords.",
              "Follow the selectedTitle if provided. Respect topicsToCover, forbiddenWords, tone, and readingLevel in the keywordPlan.",
              "Mention the estimated upside only if it helps explain topic priority; never promise rankings or traffic.",
              "The first content section should work well directly under a 16:9 hero image."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              clinic: "Southtown Dental Toowoomba",
              region: "Toowoomba, Queensland, Australia",
              primaryKeyword: opportunity.query,
              page: opportunity.page,
              clicks: opportunity.clicks,
              impressions: opportunity.impressions,
              ctr: opportunity.ctr,
              position: opportunity.position,
              draftAngle: opportunity.draftAngle,
              keywordPlan: fallback.keywordPlan,
              fallbackShape: fallback
            })
          }
        ]
      })
    });
  } catch {
    return {
      ...fallback,
      publishStatus: {
        ...fallback.publishStatus,
        lastMessage: "AI generation was unavailable, so a template draft was created."
      }
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return fallback;
  }

  const payload = await response.json().catch(() => ({}));
  const text = extractResponseText(payload);

  if (!text) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(text);
    return {
      ...fallback,
      ...parsed,
      primaryKeyword: opportunity.query,
      secondaryKeywords: parsed.secondaryKeywords || fallback.secondaryKeywords,
      keywordPlan: fallback.keywordPlan,
      heroImageUrl: parsed.heroImageUrl || fallback.heroImageUrl,
      heroImageAlt: parsed.heroImageAlt || fallback.heroImageAlt,
      faq: Array.isArray(parsed.faq) ? parsed.faq : fallback.faq,
      safetyNotes: Array.isArray(parsed.safetyNotes) ? parsed.safetyNotes : fallback.safetyNotes,
      approvalStatus: "Ready for review",
      publishStatus: { wix: "Not sent", facebook: "Not sent" },
      generationSource: "OpenAI"
    };
  } catch {
    return fallback;
  }
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const chunks = [];

  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function heroImagePrompt(draft) {
  return [
    "Create a 16:9 landscape hero image for a dental clinic blog article.",
    `Article title: ${draft.title || "Dental care in Toowoomba"}.`,
    `Primary keyword: ${draft.primaryKeyword || "dental care"}.`,
    "Clinic/location context: Southtown Dental Toowoomba, Queensland, Australia.",
    "Visual direction: modern, clean, bright, calm, trustworthy, professional dental care.",
    "Use a realistic editorial/blog style suitable for a family dental clinic website.",
    "Show a welcoming dental clinic environment, friendly oral health theme, or subtle dental-care objects.",
    "Avoid surgery, blood, needles, pain, fear, exaggerated whitening, before-and-after claims, logos, brand marks, and any text in the image.",
    "Do not show an active invasive dental procedure. Keep it reassuring and general."
  ].join(" ");
}

function extractImageCall(payload) {
  return (payload.output || []).find((item) => item.type === "image_generation_call" && item.result);
}

async function generateHeroImage(draft) {
  if (!env.OPENAI_API_KEY) {
    return {
      ok: false,
      message: "OpenAI API key is missing, so the image could not be generated.",
      draft
    };
  }

  const prompt = heroImagePrompt(draft);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.OPENAI_IMAGE_TIMEOUT_MS || 120000));

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-5.5",
        input: prompt,
        tools: [
          {
            type: "image_generation",
            size: env.OPENAI_IMAGE_SIZE || "1536x864",
            quality: env.OPENAI_IMAGE_QUALITY || "medium"
          }
        ]
      })
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ok: false,
        message: payload.error?.message || "Image generation failed.",
        draft,
        result: payload
      };
    }

    const imageCall = extractImageCall(payload);

    if (!imageCall) {
      return {
        ok: false,
        message: payload.output_text || "Image generation completed without returning an image.",
        draft,
        result: payload
      };
    }

    await fs.mkdir(generatedImagesPath, { recursive: true });
    const filename = `${slugify(draft.slug || draft.title || "hero-image")}-${Date.now()}.png`;
    const filePath = path.join(generatedImagesPath, filename);
    await fs.writeFile(filePath, Buffer.from(imageCall.result, "base64"));

    const updatedDraft = {
      ...draft,
      heroImageUrl: `/generated-images/${filename}`,
      heroImageAlt: draft.heroImageAlt || `${draft.primaryKeyword || draft.title} dental care in Toowoomba`,
      heroImagePrompt: prompt,
      heroImageRevisedPrompt: imageCall.revised_prompt || "",
      heroImageAspectRatio: "16:9",
      heroImageGeneratedAt: new Date().toISOString()
    };

    return {
      ok: true,
      message: "16:9 hero image generated.",
      draft: updatedDraft
    };
  } catch (error) {
    return {
      ok: false,
      message: error.name === "AbortError" ? "Image generation timed out. Try again in a moment." : error.message,
      draft
    };
  } finally {
    clearTimeout(timeout);
  }
}

function wixPayload(draft) {
  return {
    title: draft.title,
    slug: draft.slug,
    excerpt: draft.excerpt || draft.metaDescription,
    heroImageUrl: draft.heroImageUrl || "",
    heroImageAlt: draft.heroImageAlt || "",
    heroImageAspectRatio: draft.heroImageAspectRatio || "",
    seoTitle: draft.seoTitle,
    metaDescription: draft.metaDescription,
    contentMarkdown: draft.body,
    primaryKeyword: draft.primaryKeyword,
    secondaryKeywords: draft.secondaryKeywords || [],
    keywordPlan: draft.keywordPlan || null,
    faq: draft.faq || [],
    approvalStatus: draft.approvalStatus
  };
}

function draftMarkdown(draft) {
  const faq = (draft.faq || []).map((item) => `### ${item.question}\n\n${item.answer}`).join("\n\n");
  const safety = (draft.safetyNotes || []).map((note) => `- ${note}`).join("\n");
  const heroImage = draft.heroImageUrl ? `![${draft.heroImageAlt || draft.title}](${draft.heroImageUrl})` : "";
  const keywordPlan = draft.keywordPlan
    ? [
        "## Keyword Strategy",
        "",
        `Primary keyword: ${draft.keywordPlan.primaryKeyword || draft.primaryKeyword}`,
        `Mandatory keywords: ${(draft.keywordPlan.mandatoryKeywords || []).join(", ")}`,
        `Optional keywords: ${(draft.keywordPlan.optionalKeywords || []).join(", ")}`,
        `Intent: ${draft.keywordPlan.searchIntent || ""}`,
        `Funnel stage: ${draft.keywordPlan.funnelStage || ""}`,
        `Density: ${draft.keywordPlan.density?.primary || ""}, exact phrase ${draft.keywordPlan.density?.exactPhraseMentions || ""}`,
        `Estimated upside: ${draft.keywordPlan.estimatedUpside?.additionalClicks || 0} extra clicks`,
        ""
      ].join("\n")
    : "";
  return [
    "---",
    `title: ${JSON.stringify(draft.title)}`,
    `seoTitle: ${JSON.stringify(draft.seoTitle)}`,
    `metaDescription: ${JSON.stringify(draft.metaDescription)}`,
    `slug: ${JSON.stringify(draft.slug)}`,
    `primaryKeyword: ${JSON.stringify(draft.primaryKeyword)}`,
    `heroImageUrl: ${JSON.stringify(draft.heroImageUrl || "")}`,
    `heroImageAlt: ${JSON.stringify(draft.heroImageAlt || "")}`,
    `approvalStatus: ${JSON.stringify(draft.approvalStatus)}`,
    "---",
    "",
    heroImage,
    heroImage ? "" : "",
    keywordPlan,
    draft.body || "",
    "",
    "## FAQ",
    "",
    faq,
    "",
    "## Facebook Post",
    "",
    draft.facebookPost || "",
    "",
    "## Safety Notes",
    "",
    safety
  ].join("\n");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function listDrafts() {
  await fs.mkdir(path.dirname(draftsPath), { recursive: true });
  const raw = await fs.readFile(draftsPath, "utf8").catch(() => "[]");
  return JSON.parse(raw);
}

async function saveDraft(draft) {
  const drafts = await listDrafts();
  const now = new Date().toISOString();
  const saved = { ...draft, id: draft.id || randomUUID(), updatedAt: now, createdAt: draft.createdAt || now };
  await fs.writeFile(draftsPath, JSON.stringify([saved, ...drafts.filter((item) => item.id !== saved.id)], null, 2));
  return saved;
}

async function listHistory() {
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  const raw = await fs.readFile(historyPath, "utf8").catch(() => "[]");
  return JSON.parse(raw);
}

async function saveHistory(entry) {
  const history = await listHistory();
  const saved = {
    id: entry.id || randomUUID(),
    status: entry.status || "Published",
    createdAt: entry.createdAt || new Date().toISOString(),
    ...entry
  };
  await fs.writeFile(historyPath, JSON.stringify([saved, ...history.filter((item) => item.id !== saved.id)], null, 2));
  return saved;
}

function wixHeaders() {
  return {
    Authorization: env.WIX_API_KEY,
    "wix-site-id": env.WIX_SITE_ID,
    "Content-Type": "application/json"
  };
}

function wixMemberId() {
  return String(env.WIX_MEMBER_ID || "").split("@")[0].trim();
}

function textNode(text) {
  return {
    id: randomUUID(),
    type: "TEXT",
    nodes: [],
    textData: {
      text: String(text || "").replace(/\s+/g, " ").trim(),
      decorations: []
    }
  };
}

function spacerNode() {
  return {
    id: randomUUID(),
    type: "PARAGRAPH",
    nodes: [
      {
        id: randomUUID(),
        type: "TEXT",
        nodes: [],
        textData: {
          text: "\u00a0",
          decorations: []
        }
      }
    ],
    paragraphData: {
      textStyle: { textAlignment: "AUTO" }
    }
  };
}

function pushContentNode(nodes, node) {
  if (nodes.length) {
    nodes.push(spacerNode());
  }
  nodes.push(node);
}

function paragraphNode(text) {
  return {
    id: randomUUID(),
    type: "PARAGRAPH",
    nodes: [textNode(text)],
    paragraphData: {
      textStyle: { textAlignment: "AUTO" }
    }
  };
}

function headingNode(text, level) {
  return {
    id: randomUUID(),
    type: "HEADING",
    nodes: [textNode(text)],
    headingData: {
      level: Math.min(level, 3),
      textStyle: { textAlignment: "AUTO" }
    }
  };
}

function imageNode(image) {
  const url = image?.url || image?.heroImageUrl;
  const id = image?.id || image?.fileId;

  if (!url && !id) {
    return null;
  }

  return {
    id: randomUUID(),
    type: "IMAGE",
    nodes: [],
    imageData: {
      image: {
        src: {
          ...(id ? { id } : {}),
          ...(url ? { url } : {})
        },
        width: image.width || 1536,
        height: image.height || 864
      },
      altText: image.altText || "",
      containerData: {
        alignment: "CENTER",
        textWrap: false
      }
    }
  };
}

function localGeneratedImagePath(heroImageUrl) {
  if (!heroImageUrl || !heroImageUrl.startsWith("/generated-images/")) {
    return null;
  }

  return path.join(generatedImagesPath, path.basename(heroImageUrl));
}

async function uploadLocalHeroImageToWix(draft) {
  const imagePath = localGeneratedImagePath(draft.heroImageUrl);

  if (!imagePath) {
    return draft.heroImageUrl
      ? {
          url: draft.heroImageUrl,
          altText: draft.heroImageAlt || draft.title,
          width: 1536,
          height: 864,
          source: "external"
        }
      : null;
  }

  const image = await fs.readFile(imagePath).catch(() => null);

  if (!image) {
    throw new Error("The generated hero image file could not be found locally.");
  }

  const filename = path.basename(imagePath);
  const uploadUrlResponse = await fetch("https://www.wixapis.com/site-media/v1/files/generate-upload-url", {
    method: "POST",
    headers: wixHeaders(),
    body: JSON.stringify({
      fileName: filename,
      mimeType: "image/png",
      mediaType: "IMAGE"
    })
  });
  const uploadUrlResult = await uploadUrlResponse.json().catch(() => ({}));

  if (!uploadUrlResponse.ok) {
    throw new Error(uploadUrlResult.message || uploadUrlResult.error?.message || "Wix media upload URL creation failed.");
  }

  const uploadUrl = uploadUrlResult.uploadUrl || uploadUrlResult.upload_url || uploadUrlResult.url;

  if (!uploadUrl) {
    throw new Error("Wix did not return a media upload URL.");
  }

  let uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: image
  });

  if (uploadResponse.status === 405 || uploadResponse.status === 404) {
    uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: image
    });
  }

  const uploadResult = await uploadResponse.json().catch(() => ({}));

  if (!uploadResponse.ok) {
    throw new Error(uploadResult.message || uploadResult.error?.message || "Wix media upload failed.");
  }

  const file = uploadResult.file || uploadResult.fileDescriptor || uploadResult.fileInfo || uploadUrlResult.file || uploadUrlResult.fileDescriptor || uploadResult;
  const url = file.url || file.fileUrl || file.mediaUrl || file.thumbnailUrl || file.originalFileUrl;
  const id = file.id || file._id || file.fileId || file.mediaId || uploadUrlResult.fileId || uploadUrlResult.mediaId;

  if (!url && !id) {
    throw new Error("Wix uploaded the image but did not return a usable file URL or ID.");
  }

  return {
    id,
    url,
    altText: draft.heroImageAlt || draft.title,
    width: file.width || file.image?.width || 1536,
    height: file.height || file.image?.height || 864,
    source: "wix",
    uploadResult
  };
}

function richContentFromMarkdown(markdown, title, heroImage) {
  const nodes = [];
  const heroNode = imageNode(heroImage);

  if (heroNode) {
    nodes.push(heroNode);
  }

  const lines = String(markdown || "").split(/\r?\n/);
  let paragraphLines = [];

  function flushParagraph() {
    const text = paragraphLines.join(" ").replace(/^[-*]\s+/gm, "").replace(/\s+/g, " ").trim();
    if (text) {
      pushContentNode(nodes, paragraphNode(text));
    }
    paragraphLines = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);

    if (heading) {
      flushParagraph();
      const headingText = heading[2].trim();
      if (!(heading[1].length === 1 && headingText === String(title || "").trim())) {
        pushContentNode(nodes, headingNode(headingText, heading[1].length));
      }
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  return {
    nodes,
    metadata: {
      version: 1
    }
  };
}

async function publishToWix(draft) {
  if (!env.WIX_API_KEY || !env.WIX_SITE_ID) {
    return {
      ok: false,
      status: "Needs credentials",
      message: "Wix API key or site ID is missing.",
      payload: wixPayload(draft)
    };
  }

  const memberId = wixMemberId();

  if (!memberId) {
    return {
      ok: false,
      status: "Needs post owner",
      message: "Wix needs WIX_MEMBER_ID for the blog post owner/author before it can publish through the API.",
      payload: wixPayload(draft)
    };
  }

  let wixHeroImage = null;

  if (draft.heroImageUrl) {
    try {
      wixHeroImage = await uploadLocalHeroImageToWix(draft);
    } catch (error) {
      return {
        ok: false,
        status: "Image upload error",
        message: error.message,
        payload: wixPayload(draft)
      };
    }
  }

  const draftPost = {
    title: draft.title,
    excerpt: (draft.excerpt || draft.metaDescription || "").slice(0, 500),
    seoSlug: draft.slug,
    richContent: richContentFromMarkdown(draft.body, draft.title, wixHeroImage),
    commentingEnabled: true,
    featured: false,
    hashtags: []
  };

  draftPost.memberId = memberId;

  const createResponse = await fetch("https://www.wixapis.com/blog/v3/draft-posts", {
    method: "POST",
    headers: wixHeaders(),
    body: JSON.stringify({ draftPost })
  });
  const createResult = await createResponse.json().catch(() => ({}));

  if (!createResponse.ok) {
    return {
      ok: false,
      status: "Error",
      message: createResult.message || createResult.error?.message || "Wix draft creation failed.",
      result: createResult,
      payload: { draftPost }
    };
  }

  const draftPostId = createResult.draftPost?.id || createResult.draft?.id || createResult.id;

  if (!draftPostId) {
    return {
      ok: false,
      status: "Error",
      message: "Wix created a draft response, but no draft post ID was returned.",
      result: createResult
    };
  }

  const publishResponse = await fetch(`https://www.wixapis.com/blog/v3/draft-posts/${draftPostId}/publish`, {
    method: "POST",
    headers: wixHeaders(),
    body: JSON.stringify({})
  });
  const publishResult = await publishResponse.json().catch(() => ({}));

  if (!publishResponse.ok) {
    return {
      ok: false,
      status: "Error",
      message: publishResult.message || publishResult.error?.message || "Wix publish failed after draft creation.",
      draftPostId,
      result: publishResult
    };
  }

  const historyEntry = await saveHistory({
    title: draft.title,
    slug: draft.slug,
    primaryKeyword: draft.primaryKeyword,
    heroImageUrl: draft.heroImageUrl,
    draftPostId,
    wixHeroImage: wixHeroImage ? { id: wixHeroImage.id, url: wixHeroImage.url } : null,
    publishedAt: new Date().toISOString(),
    channel: "Wix Blog",
    status: "Published"
  });

  return {
    ok: true,
    status: "Published",
    message: "Published to Wix Blog.",
    draftPostId,
    wixHeroImage: wixHeroImage ? { id: wixHeroImage.id, url: wixHeroImage.url } : null,
    historyEntry,
    result: publishResult
  };
}

export async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname === "/") return send(res, 200, html(await hasGoogleTokens(req)), { "Content-Type": "text/html; charset=utf-8" });
    if (url.pathname.startsWith("/generated-images/")) {
      const filename = path.basename(decodeURIComponent(url.pathname));
      const filePath = path.join(generatedImagesPath, filename);
      const image = await fs.readFile(filePath).catch(() => null);
      if (!image) return json(res, 404, { error: "Image not found." });
      return send(res, 200, image, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000" });
    }
    if (url.pathname === "/api/auth/google") {
      const authUrl = (await oauthClient()).generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/webmasters.readonly"] });
      res.writeHead(302, { Location: authUrl }); return res.end();
    }
    if (url.pathname === "/api/auth/google/callback") {
      const { tokens } = await (await oauthClient()).getToken(url.searchParams.get("code"));
      let savedTokens = tokens;
      let location = "/";
      try {
        savedTokens = await saveGoogleTokens(tokens);
      } catch (error) {
        location = `/?gscStorage=browser-only&reason=${encodeURIComponent(error.message)}`;
      }
      res.writeHead(302, { Location: location, "Set-Cookie": `google_tokens=${Buffer.from(JSON.stringify(savedTokens)).toString("base64url")}; HttpOnly; Path=/; SameSite=Lax` }); return res.end();
    }
    if (url.pathname === "/api/gsc/opportunities") {
      const tokens = await storedGoogleTokens(req);
      if (!tokens) return json(res, 401, { error: "Connect Google first." });
      const google = await getGoogle();
      const client = await oauthClient();
      client.setCredentials(tokens);
      const sc = google.searchconsole({ version: "v1", auth: client });
      const startDate = url.searchParams.get("startDate");
      const endDate = url.searchParams.get("endDate");
      const response = await sc.searchanalytics.query({ siteUrl: env.GSC_SITE_URL, requestBody: { startDate, endDate, dimensions: ["query", "page"], rowLimit: 250 } });
      const trendResponse = await sc.searchanalytics.query({ siteUrl: env.GSC_SITE_URL, requestBody: { startDate, endDate, dimensions: ["date"], rowLimit: 250 } }).catch(() => ({ data: { rows: [] } }));
      const rows = (response.data.rows || []).map((row) => ({ query: row.keys?.[0] || "", page: row.keys?.[1], clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0 }));
      const dateRows = (trendResponse.data.rows || []).map((row) => ({ date: row.keys?.[0] || "", clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0 })).sort((a, b) => a.date.localeCompare(b.date));
      const opportunities = score(rows.filter((row) => row.query));
      const insights = buildInsights(rows.filter((row) => row.query), opportunities, dateRows);
      return json(res, 200, { totals: insights.totals, insights, opportunities });
    }
    if (url.pathname === "/api/drafts" && req.method === "GET") return json(res, 200, { drafts: await listDrafts() });
    if (url.pathname === "/api/history" && req.method === "GET") return json(res, 200, { history: await listHistory() });
    if (url.pathname === "/api/drafts" && req.method === "POST") return json(res, 200, { draft: await saveDraft(JSON.parse(await readBody(req))) });
    if (url.pathname === "/api/drafts/generate") return json(res, 200, { draft: await generateDraft(JSON.parse(await readBody(req)).opportunity) });
    if (url.pathname === "/api/drafts/generate-image" && req.method === "POST") return json(res, 200, await generateHeroImage(JSON.parse(await readBody(req))));
    if (url.pathname === "/api/connectors/status") return json(res, 200, await connectorStatus(req));
    if (url.pathname === "/api/drafts/export" && req.method === "POST") {
      const draft = JSON.parse(await readBody(req));
      return send(res, 200, draftMarkdown(draft), {
        "Content-Type": "text/markdown",
        "Content-Disposition": `attachment; filename="${draft.slug || "content-draft"}.md"`
      });
    }
    if (url.pathname === "/api/publish/wix-draft" && req.method === "POST") {
      const draft = JSON.parse(await readBody(req));
      if (draft.approvalStatus !== "Approved") return json(res, 400, { error: "Approve the draft before preparing it for Wix." });
      return json(res, 200, await publishToWix(draft));
    }
    if (url.pathname === "/api/publish/facebook" && req.method === "POST") {
      const draft = JSON.parse(await readBody(req));
      if (draft.approvalStatus !== "Approved") return json(res, 400, { error: "Approve the draft before publishing to Facebook." });
      return json(res, 200, {
        ok: false,
        status: "Needs credentials",
        message: "Facebook publishing needs FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN. For now, copy the Facebook draft text manually.",
        facebookPost: draft.facebookPost
      });
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}

function html(isGoogleConnected = false) {
  const googleButton = isGoogleConnected
    ? `<a class="connect connected" href="/api/auth/google">GSC Connected</a>`
    : `<a class="connect" href="/api/auth/google">Connect Google</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DataDrivify Content AI</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Exo:wght@400;500;600;700;800&display=swap" rel="stylesheet"><style>${css()}</style></head><body><div class="app"><aside class="side"><div class="brand"><div class="logo"><span>D</span></div><div><h1>DataDrivify Content AI</h1><p>Oral Experts Group</p></div></div><nav><a class="active" href="#planner">Planner</a><a href="#insights">GSC Insights</a><a href="#historyPanel">History</a><a href="#calendarPanel">Calendar</a></nav><div class="side-card"><span>Workflow</span><b>Discover -> Plan -> Draft -> Publish</b></div>${googleButton}</aside><main class="main"><header class="top"><div><p class="eyebrow">AI content workspace</p><h2>Blog strategy and publishing cockpit</h2></div><div id="msg" class="msg">Ready</div></header><section class="command"><div class="date-field"><label>Start</label><input id="start" type="date"></div><div class="date-field"><label>End</label><input id="end" type="date"></div><button onclick="findIdeas()">Find Ideas</button></section><section id="insights" class="insights empty">Run Search Console to see keyword insights.</section><section id="planner" class="grid"><div class="workspace-card"><div class="section-title"><h2>SEO Opportunities</h2><p>Choose a keyword, tune the strategy, then generate.</p></div><table><tbody id="rows"></tbody></table></div><aside class="workspace-card review"><div class="section-title"><h2>Review Draft</h2><p>Planner, editor, image, and publish controls.</p></div><div id="draft">Select an opportunity to start planning.</div></aside></section><section class="lower-grid"><div id="calendarPanel" class="workspace-card"><div class="section-title"><h2>Content Calendar</h2><p>Recent and planned publishing activity.</p></div><div id="calendar">No calendar items yet.</div></div><div id="historyPanel" class="workspace-card"><div class="section-title"><h2>Publish History</h2><p>Saved locally after successful Wix publishing.</p></div><div id="history">No posts published from this tool yet.</div></div></section></main></div><div id="busy" class="busy hidden"><div class="orb"><span></span><span></span><span></span></div><h3 id="busyTitle">Content AI is working</h3><p id="busyText">Thinking through the next best move...</p></div><script>${clientJs()}</script></body></html>`;
}

function css() {
  return `
:root{--blue:#2f73ff;--blue2:#5b8cff;--ink:#172033;--muted:#7c8798;--line:#dfe6f1;--panel:#fff;--bg:#f4f7fb;--soft:#eef4ff;--green:#0b7c67;--cyan:#20a2c7}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:'Exo',Arial,sans-serif;margin:0;background:var(--bg);color:var(--ink);line-height:1.35}
b,strong{font-weight:600}
.app{display:grid;grid-template-columns:260px 1fr;min-height:100vh}
.side{background:#fff;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:22px;padding:26px 18px;position:sticky;top:0;height:100vh}
.brand{align-items:center;display:flex;gap:12px}
.logo{align-items:center;background:linear-gradient(135deg,var(--blue),#0f49d8);border-radius:14px;box-shadow:0 12px 24px rgba(47,115,255,.22);color:#fff;display:flex;font-weight:700;height:46px;justify-content:center;width:46px}
.logo span{font-size:21px;line-height:1}
.brand h1{font-size:17px;font-weight:700;line-height:1.08;margin:0;max-width:160px}
.brand p,.eyebrow{color:#9aa6b8;font-size:11px;font-weight:600;letter-spacing:.11em;margin:5px 0 0;text-transform:uppercase}
nav{display:grid;gap:8px}
nav a,.connect{border-radius:10px;color:#637083;font-weight:600;padding:12px 14px;text-decoration:none}
nav a.active,nav a:hover{background:var(--soft);color:var(--blue)}
.connect{background:var(--blue);box-shadow:0 12px 30px rgba(47,115,255,.22);color:white;margin-top:auto;text-align:center}
.connect.connected{background:#edf8f5;box-shadow:none;color:var(--green)}
.side-card{background:#f7faff;border:1px solid var(--line);border-radius:12px;padding:13px}
.side-card span{color:#94a0b3;font-size:12px}
.side-card b{display:block;font-size:13px;font-weight:600;margin-top:5px}
.main{padding:28px 34px}
.top{align-items:center;display:flex;justify-content:space-between;margin-bottom:20px}
.top h2{font-size:28px;font-weight:700;margin:4px 0 0}
.msg{background:#fff;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:13px;font-weight:600;max-width:420px;overflow:hidden;padding:9px 14px;text-overflow:ellipsis;white-space:nowrap}
.command,.workspace-card,.panel,.metric{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 32px rgba(21,33,56,.04)}
.command{align-items:end;display:grid;grid-template-columns:1fr 1fr auto;gap:12px;margin-bottom:16px;padding:16px}
.date-field label,.field label{color:#94a0b3;display:block;font-size:11px;font-weight:600;letter-spacing:.1em;margin-bottom:6px;text-transform:uppercase}
input,textarea{background:#f7f9fd;border:1px solid var(--line);border-radius:10px;color:var(--ink);font:500 14px 'Exo',Arial,sans-serif;padding:12px;width:100%}
textarea{min-height:112px;resize:vertical}
button{background:var(--blue);border:0;border-radius:10px;box-shadow:0 10px 24px rgba(47,115,255,.18);color:white;cursor:pointer;font:700 14px 'Exo',Arial,sans-serif;padding:12px 16px;transition:transform .15s ease,box-shadow .15s ease}
button:hover{box-shadow:0 12px 30px rgba(47,115,255,.28);transform:translateY(-1px)}
button.secondary{background:#eef4ff;box-shadow:none;color:var(--blue)}
button:disabled{cursor:not-allowed;opacity:.55;transform:none}
.grid{display:grid;grid-template-columns:1.18fr .95fr;gap:18px}
.review{align-self:start;max-height:calc(100vh - 36px);overflow:auto;position:sticky;top:18px}
.lower-grid,.dash,.metrics,.brief-grid{display:grid;gap:14px}
.lower-grid{grid-template-columns:1fr 1fr;margin-top:18px}
.dash,.brief-grid{grid-template-columns:1fr 1fr}
.metrics{grid-template-columns:repeat(6,1fr);margin:10px 0 14px}
.workspace-card,.insights.empty{padding:18px}
.section-title{align-items:flex-end;display:flex;gap:12px;justify-content:space-between;margin-bottom:12px}
.section-title h2,.insights h2{font-size:23px;font-weight:700;margin:0}
.section-title p{color:var(--muted);font-size:13px;margin:4px 0 0}
.insights{margin-bottom:18px}
.insights.empty{background:#fff;border:1px dashed var(--line);border-radius:14px;color:var(--muted)}
.metric{padding:13px}
.metric span{color:var(--muted);font-size:12px;font-weight:600}
.metric b{display:block;font-size:23px;font-weight:600;margin-top:5px}
.panel{padding:14px}
.panel h3,.publish h3,.brief h3{font-size:15px;font-weight:600;margin:0 0 10px}
table{border-collapse:collapse;width:100%}
tr:hover td{background:#fbfdff}
td{border-top:1px solid var(--line);font-size:13px;padding:14px;vertical-align:top}
.muted{color:var(--muted);font-size:12px}
.pill{background:#eef4ff;border-radius:999px;color:#2161df;display:inline-block;font-size:11px;font-weight:600;margin:3px 4px 3px 0;padding:5px 9px}
.brief{background:#f8fbff;border:1px solid var(--line);border-radius:12px;margin:11px 0;padding:12px}
.field{display:grid;gap:4px;margin:10px 0}
.actions{display:flex;flex-wrap:wrap;gap:9px}
.status{background:#edf8f5;border:1px solid #bfe5dc;border-radius:12px;color:var(--green);font-weight:600;margin:10px 0;padding:12px}
.hero-preview{aspect-ratio:16/9;background:#eef3ff;border:1px solid var(--line);border-radius:12px;margin:10px 0;overflow:hidden}
.hero-preview img{display:block;height:100%;object-fit:cover;width:100%}
.barrow{align-items:center;display:grid;font-size:12px;gap:8px;grid-template-columns:minmax(120px,1fr) 2.5fr 64px;margin:8px 0}
.track{background:#e8eef8;border-radius:999px;height:7px;overflow:hidden}
.fill{background:#4f83ff;height:100%}
.fill.alt{background:var(--cyan)}
.chart{display:block;height:178px;overflow:visible;width:100%}
.axis{stroke:#d8e2f0;stroke-width:.8;vector-effect:non-scaling-stroke}
.gridline{stroke:#edf2f8;stroke-width:.7;vector-effect:non-scaling-stroke}
.trend-line{fill:none;stroke:#2f73ff;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.15;vector-effect:non-scaling-stroke}
.axis-label{fill:#7c8798;font:500 12px 'Exo',Arial,sans-serif}
.chart-note{margin-top:4px}
.publish{background:#f8fbff;border:1px solid var(--line);border-radius:12px;margin-top:12px;padding:12px}
.publish p{color:var(--muted);font-size:13px;line-height:1.45;margin:0 0 10px}
pre{background:#f7f9fd;border:1px solid var(--line);border-radius:10px;max-height:220px;overflow:auto;padding:10px;white-space:pre-wrap}
.history-item{border-top:1px solid var(--line);padding:12px 0}
.history-item:first-child{border-top:0}
.history-item b,.calendar-item b{display:block;font-size:14px}
.calendar-list{display:grid;gap:9px}
.calendar-item{align-items:center;background:#f8fbff;border:1px solid var(--line);border-radius:12px;display:grid;gap:10px;grid-template-columns:80px 1fr;padding:10px}
.cal-date{background:#eef4ff;border-radius:10px;color:var(--blue);font-weight:600;padding:9px;text-align:center}
.busy{align-items:center;background:rgba(15,23,42,.45);backdrop-filter:blur(10px);bottom:0;display:flex;flex-direction:column;justify-content:center;left:0;position:fixed;right:0;top:0;z-index:50}
.busy.hidden{display:none}
.busy h3,.busy p{color:#fff;margin:8px 0 0;text-align:center}
.orb{align-items:center;background:linear-gradient(135deg,var(--blue),#7aa2ff);border-radius:28px;box-shadow:0 24px 60px rgba(47,115,255,.45);display:flex;gap:8px;height:92px;justify-content:center;width:92px}
.orb span{animation:pulse 1s infinite ease-in-out;background:#fff;border-radius:999px;height:10px;width:10px}
.orb span:nth-child(2){animation-delay:.15s}
.orb span:nth-child(3){animation-delay:.3s}
@keyframes pulse{0%,80%,100%{opacity:.35;transform:translateY(0)}40%{opacity:1;transform:translateY(-9px)}}
@media(max-width:980px){.app{grid-template-columns:1fr}.side{height:auto;position:static}.grid,.dash,.lower-grid,.brief-grid,.command{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.review{max-height:none;position:static}}
`;
}

function clientJs() {
  return `
const today=new Date();
end.value=today.toISOString().slice(0,10);
today.setDate(today.getDate()-90);
start.value=today.toISOString().slice(0,10);
let currentDraft=null;
let ops=[];
let selectedOpportunity=null;

function esc(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmt(v){return Math.round(Number(v||0)).toLocaleString()}
function pct(v){return (Number(v||0)*100).toFixed(1)+'%'}
function pos(v){return Number(v||0).toFixed(1)}
function chips(items){return (items||[]).map(item=>'<span class=pill>'+esc(item)+'</span>').join(' ')}
function listToText(items){return (items||[]).join('\\n')}
function textToList(text){return String(text||'').split(/\\n|,/).map(x=>x.trim()).filter(Boolean)}
function showBusy(title,text){
  busyTitle.textContent=title||'Content AI is working';
  busyText.textContent=text||'Thinking through the next best move...';
  busy.classList.remove('hidden');
}
function hideBusy(){busy.classList.add('hidden')}
function keywordBrief(plan){
  if(!plan){return ''}
  const upside=plan.estimatedUpside||{};
  return '<div class=brief><h3>Keyword Strategy</h3><div class=brief-grid><div><div class=muted>Mandatory keywords</div>'+chips(plan.mandatoryKeywords)+'</div><div><div class=muted>Optional keywords</div>'+chips(plan.optionalKeywords)+'</div><div><div class=muted>Intent / funnel</div><b>'+esc(plan.searchIntent||'')+'</b><div class=muted>'+esc(plan.funnelStage||'')+'</div></div><div><div class=muted>Density target</div><b>'+esc(plan.density?.primary||'Natural')+'</b><div class=muted>Exact phrase '+esc(plan.density?.exactPhraseMentions||'2-3')+' - supporting '+esc(plan.density?.supportingMentions||'1-2 each')+'</div></div></div><p class=muted>'+esc(plan.brief||'')+'</p><p class=muted>Estimated upside: '+fmt(upside.additionalClicks)+' extra clicks. '+esc(upside.basis||'Estimate only; not a ranking promise.')+'</p></div>';
}
function planField(key,label,value,help){
  return '<div class=field><label>'+label+'</label>'+(help?'<div class=muted>'+help+'</div>':'')+'<textarea id="plan_'+key+'" onchange="syncPlanner()">'+esc(value||'')+'</textarea></div>';
}
function titleOptionsHtml(plan){
  return (plan.titleOptions||[]).map((title,idx)=>'<label class=muted style="display:block;margin:6px 0"><input type="radio" name="titleOption" value="'+idx+'" '+((plan.selectedTitle||plan.titleOptions?.[0])===title?'checked':'')+' onchange="selectTitleOption('+idx+')"> '+esc(title)+'</label>').join('');
}
function renderPlanner(index){
  selectedOpportunity=JSON.parse(JSON.stringify(ops[index]));
  const plan=selectedOpportunity.keywordPlan||{};
  plan.selectedTitle=plan.selectedTitle||plan.titleOptions?.[0]||selectedOpportunity.query;
  selectedOpportunity.keywordPlan=plan;
  currentDraft=null;
  draft.innerHTML='<div class=brief><h3>Content Planner</h3><div class=muted>Pick a title and edit the strategy before generating.</div>'+titleOptionsHtml(plan)+planField('mandatory','Mandatory keywords',listToText(plan.mandatoryKeywords),'One per line or comma separated.')+planField('optional','Optional keywords',listToText(plan.optionalKeywords),'Supporting phrases to include where natural.')+planField('topics','Topics to cover',listToText(plan.topicsToCover),'Add any sections or questions you explicitly want covered.')+planField('forbidden','Forbidden words',listToText(plan.forbiddenWords),'Words or claims the draft should avoid.')+planField('tone','Tone',plan.tone||'Professional, calm, patient-friendly')+planField('reading','Reading level',plan.readingLevel||'Grade 8-10')+'<div class=brief-grid><div>'+planField('density','Primary keyword density',plan.density?.primary||'0.6-1.0%')+'</div><div>'+planField('exact','Exact phrase mentions',plan.density?.exactPhraseMentions||'2-3')+'</div></div><div class=actions><button onclick="generatePlannedDraft()">Generate From Plan</button></div></div>';
}
function selectTitleOption(idx){
  if(!selectedOpportunity)return;
  const plan=selectedOpportunity.keywordPlan||{};
  plan.selectedTitle=plan.titleOptions?.[idx]||plan.selectedTitle;
  selectedOpportunity.keywordPlan=plan;
}
function syncPlanner(){
  if(!selectedOpportunity)return;
  const plan=selectedOpportunity.keywordPlan||{};
  plan.mandatoryKeywords=textToList(document.getElementById('plan_mandatory')?.value);
  plan.optionalKeywords=textToList(document.getElementById('plan_optional')?.value);
  plan.topicsToCover=textToList(document.getElementById('plan_topics')?.value);
  plan.forbiddenWords=textToList(document.getElementById('plan_forbidden')?.value);
  plan.tone=document.getElementById('plan_tone')?.value||plan.tone;
  plan.readingLevel=document.getElementById('plan_reading')?.value||plan.readingLevel;
  plan.density=plan.density||{};
  plan.density.primary=document.getElementById('plan_density')?.value||plan.density.primary;
  plan.density.exactPhraseMentions=document.getElementById('plan_exact')?.value||plan.density.exactPhraseMentions;
  plan.brief='Custom plan. Include mandatory keywords naturally: '+(plan.mandatoryKeywords||[]).join(', ')+'. Cover: '+(plan.topicsToCover||[]).join(', ')+'.';
  selectedOpportunity.keywordPlan=plan;
}

function barRows(items,labelKey,valueKey,opts){
  opts=opts||{};
  const max=opts.max||Math.max(1,...items.map(i=>Number(i[valueKey]||0)));
  return items.map(item=>{
    const value=Number(item[valueKey]||0);
    const width=Math.max(4,Math.round(value/max*100));
    const right=opts.format?opts.format(value,item):fmt(value);
    const sub=opts.sub?'<div class=muted>'+esc(opts.sub(item))+'</div>':'';
    return '<div class=barrow><div><b>'+esc(item[labelKey])+'</b>'+sub+'</div><div class=track><div class="fill '+(opts.alt?'alt':'')+'" style="width:'+width+'%"></div></div><div>'+right+'</div></div>';
  }).join('');
}

function sparkline(points){
  if(!points||points.length<2){return '<div class=muted>Not enough date data for a trend yet.</div>'}
  const values=points.map(p=>Number(p.impressions||0));
  const max=Math.max(...values,1);
  const min=Math.min(...values,0);
  const range=Math.max(max-min,1);
  const left=62;
  const right=880;
  const top=18;
  const bottom=164;
  const chartWidth=right-left;
  const chartHeight=bottom-top;
  const coords=points.map((p,i)=>{
    const x=left+(i/(points.length-1))*chartWidth;
    const y=bottom-((Number(p.impressions||0)-min)/range)*chartHeight;
    return x.toFixed(1)+','+y.toFixed(1);
  }).join(' ');
  const totalClicks=points.reduce((a,b)=>a+Number(b.clicks||0),0);
  const totalImpressions=points.reduce((a,b)=>a+Number(b.impressions||0),0);
  const start=points[0]?.date||'';
  const endDate=points[points.length-1]?.date||'';
  const mid=Math.round((min+max)/2);
  return '<svg class=chart viewBox="0 0 900 205" role="img" aria-label="Impressions trend from '+esc(start)+' to '+esc(endDate)+'">'
    +'<line class=gridline x1="'+left+'" y1="'+top+'" x2="'+right+'" y2="'+top+'"></line>'
    +'<line class=gridline x1="'+left+'" y1="'+((top+bottom)/2).toFixed(1)+'" x2="'+right+'" y2="'+((top+bottom)/2).toFixed(1)+'"></line>'
    +'<line class=axis x1="'+left+'" y1="'+bottom+'" x2="'+right+'" y2="'+bottom+'"></line>'
    +'<line class=axis x1="'+left+'" y1="'+top+'" x2="'+left+'" y2="'+bottom+'"></line>'
    +'<polyline class=trend-line points="'+coords+'"></polyline>'
    +'<text class=axis-label x="8" y="'+(top+4)+'">'+fmt(max)+'</text>'
    +'<text class=axis-label x="8" y="'+(((top+bottom)/2)+4).toFixed(1)+'">'+fmt(mid)+'</text>'
    +'<text class=axis-label x="8" y="'+(bottom+4)+'">'+fmt(min)+'</text>'
    +'<text class=axis-label x="'+left+'" y="198">Start '+esc(start)+'</text>'
    +'<text class=axis-label" x="735" y="198">End '+esc(endDate)+'</text>'
    +'</svg><div class="muted chart-note">Y-axis: impressions. X-axis: selected date range. '+fmt(totalImpressions)+' impressions - '+fmt(totalClicks)+' clicks.</div>';
}

async function loadHistory(){
  try{
    const r=await fetch('/api/history');
    const p=await r.json();
    const items=p.history||[];
    history.innerHTML=items.length?items.slice(0,8).map(renderHistoryItem).join(''):'No posts published from this tool yet.';
    calendar.innerHTML=items.length?'<div class=calendar-list>'+items.slice(0,6).map(renderCalendarItem).join('')+'</div>':'No calendar items yet.';
  }catch(e){}
}
function renderHistoryItem(item){
  const date=new Date(item.publishedAt||item.createdAt||Date.now()).toLocaleDateString();
  return '<div class=history-item><b>'+esc(item.title)+'</b><div class=muted>'+esc(item.channel||'Wix Blog')+' - '+date+' - '+esc(item.primaryKeyword||'')+'</div><span class=pill>'+esc(item.status||'Published')+'</span></div>';
}
function renderCalendarItem(item){
  const d=new Date(item.publishedAt||item.createdAt||Date.now());
  const day=d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
  return '<div class=calendar-item><div class=cal-date>'+esc(day)+'</div><div><b>'+esc(item.title)+'</b><div class=muted>'+esc(item.status||'Published')+' - '+esc(item.channel||'Wix Blog')+'</div></div></div>';
}

function renderInsights(data){
  const i=data.insights;
  if(!i){insights.className='insights empty';insights.textContent='No insights returned.';return}
  insights.className='insights';
  const totals=i.totals||{};
  const metrics=[
    ['Clicks',fmt(totals.clicks)],
    ['Impressions',fmt(totals.impressions)],
    ['Avg CTR',pct(totals.ctr)],
    ['Avg position',pos(totals.averagePosition)],
    ['Queries',fmt(i.status.queryCount)],
    ['Opportunities',fmt(i.status.contentOpportunities)]
  ].map(m=>'<div class=metric><span>'+m[0]+'</span><b>'+m[1]+'</b></div>').join('');
  const clusterBars=barRows(i.clusters||[],'label','impressions',{sub:item=>item.queries+' queries - '+pct(item.ctr)+' CTR'});
  const bucketBars=barRows(i.positionBuckets||[],'label','count',{alt:true,sub:item=>fmt(item.impressions)+' impressions'});
  const gapRows=(i.ctrGaps||[]).map(item=>'<tr><td><b>'+esc(item.query)+'</b><div class=muted>'+esc(item.priority)+' priority - avg pos '+pos(item.position)+'</div></td><td>'+fmt(item.impressions)+'</td><td>'+pct(item.ctr)+'</td></tr>').join('');
  const topRows=(i.topQueries||[]).map(item=>'<tr><td><b>'+esc(item.query)+'</b><div class=muted>'+esc(item.cluster)+' - avg pos '+pos(item.position)+'</div></td><td>'+fmt(item.impressions)+'</td><td>'+fmt(item.clicks)+'</td></tr>').join('');
  const priorities=(i.priorityCounts||[]).map(item=>'<span class=pill>'+esc(item.label)+': '+fmt(item.count)+'</span>').join(' ');
  insights.innerHTML='<h2>GSC Insights</h2><div class=metrics>'+metrics+'</div><div class=panel><h3>Content Priority</h3>'+priorities+'</div><div class=dash><div class=panel><h3>Impressions Trend</h3>'+sparkline(i.trend||[])+'</div><div class=panel><h3>Keyword Clusters</h3>'+clusterBars+'</div><div class=panel><h3>Position Distribution</h3>'+bucketBars+'</div><div class=panel><h3>CTR Gaps</h3><table><tbody>'+gapRows+'</tbody></table></div><div class=panel><h3>Top Queries</h3><table><tbody>'+topRows+'</tbody></table></div><div class=panel><h3>Decision Notes</h3><p class=muted>Prioritize high-impression, low-CTR terms for title/meta refreshes; near-page-one terms for focused articles; and repeated local terms for clusters.</p></div></div>';
}

async function findIdeas(){
  msg.textContent='Loading Search Console...';
  showBusy('Reading Search Console','Finding high-value keyword opportunities and clusters.');
  try{
    const r=await fetch('/api/gsc/opportunities?startDate='+start.value+'&endDate='+end.value);
    const p=await r.json();
    if(!r.ok){msg.textContent=p.error;return}
    ops=p.opportunities||[];
    window.ops=ops;
    renderInsights(p);
    msg.textContent='Rows: '+fmt(p.totals.rows)+' - Impressions: '+fmt(p.totals.impressions)+' - CTR: '+pct(p.totals.ctr);
    rows.innerHTML=ops.map((o,i)=>{
      const plan=o.keywordPlan||{};
      const upside=plan.estimatedUpside||{};
      const mandatory=chips(plan.mandatoryKeywords);
      const optional=chips((plan.optionalKeywords||[]).slice(0,4));
      return '<tr><td><b>'+esc(o.query)+'</b><div class=muted>'+esc(o.draftAngle)+'</div><div><span class=pill>'+esc(o.priority)+'</span> <span class=pill>'+esc(o.cluster)+'</span> <span class=pill>'+esc(o.contentType)+'</span> <span class=pill>'+esc(plan.searchIntent||'Intent')+'</span></div><div class=brief><div class=muted>Use these keywords in the draft</div><div>'+mandatory+'</div><div class=muted>Optional support</div><div>'+optional+'</div><div class=muted>Density '+esc(plan.density?.primary||'Natural')+' - estimated upside '+fmt(upside.additionalClicks)+' clicks</div></div></td><td>'+fmt(o.impressions)+' impressions<br>'+pos(o.position)+' position<br>'+pct(o.ctr)+' CTR</td><td><button onclick="renderPlanner('+i+')">Plan</button></td></tr>';
    }).join('');
  }finally{
    hideBusy();
  }
}

async function gen(i){
  selectedOpportunity=JSON.parse(JSON.stringify(ops[i]));
  return generatePlannedDraft();
}

async function generatePlannedDraft(){
  if(!selectedOpportunity){msg.textContent='Pick an opportunity first.';return}
  syncPlanner();
  msg.textContent='Generating draft...';
  showBusy('Drafting with AI','Using your title, keyword strategy, and topic brief.');
  try{
    const r=await fetch('/api/drafts/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({opportunity:selectedOpportunity})});
    const p=await r.json();
    if(!r.ok||!p.draft){msg.textContent=p.error||'Draft generation failed.';return}
    currentDraft=p.draft;
    msg.textContent='Draft generated via '+(currentDraft.generationSource||'Template');
    renderDraft();
  }catch(e){msg.textContent='Draft generation failed. Restart the local server and try again.'}
  finally{hideBusy()}
}

function field(k,label,help){return '<div class=field><label>'+label+'</label>'+(help?'<div class=muted>'+help+'</div>':'')+'<textarea onchange="currentDraft[\\''+k+'\\']=this.value">'+esc(currentDraft[k])+'</textarea></div>'}
function renderDraft(extra=''){
  const approved=currentDraft&&currentDraft.approvalStatus==='Approved';
  const imagePreview=currentDraft.heroImageUrl?'<div class=hero-preview><img src="'+esc(currentDraft.heroImageUrl)+'" alt="'+esc(currentDraft.heroImageAlt)+'"></div>':'<div class=muted>No generated hero image yet.</div>';
  const imageBlock=imagePreview+'<div class=actions><button class=secondary onclick="generateImage()">Generate 16:9 Image</button></div>';
  const strategy=keywordBrief(currentDraft.keywordPlan);
  const fields=[field('title','title'),field('seoTitle','seoTitle'),field('slug','slug'),field('metaDescription','metaDescription'),field('heroImageUrl','heroImageUrl','Generated or pasted 16:9 image URL for the visual section under the title.'),field('heroImageAlt','heroImageAlt','Describe the image for accessibility and SEO.')].join('')+imageBlock+[field('body','body'),field('facebookPost','facebookPost')].join('');
  draft.innerHTML=(approved?'<div class=status>Approved. You can now publish directly to Wix Blog.</div>':'')+strategy+fields+'<div class=actions><button onclick="save()">Save Draft</button><button onclick="approve()">Mark Approved</button><button class=secondary onclick="exportDraft()">Export Markdown</button></div><div class=publish><h3>Publishing actions</h3><p>Wix is configured to create and publish immediately. Facebook still needs Meta credentials.</p><div class=actions><button '+(!approved?'disabled':'')+' onclick="publishWix()">Publish Wix Blog</button><button '+(!approved?'disabled':'')+' onclick="publishFacebook()">Publish Facebook</button></div><div id=publishResult>'+extra+'</div></div>';
}

async function generateImage(){
  if(!currentDraft){msg.textContent='Generate a draft first.';return}
  msg.textContent='Generating 16:9 image... this can take up to 2 minutes.';
  showBusy('Generating hero image','Creating a 16:9 visual matched to this article topic.');
  try{
    const r=await fetch('/api/drafts/generate-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentDraft)});
    const p=await r.json();
    if(p.draft){currentDraft=p.draft}
    msg.textContent=p.message||p.error||'Image generation finished.';
    renderDraft('<div class=status>'+esc(p.message||p.error||'Image generation finished.')+'</div>');
  }catch(e){msg.textContent='Image generation failed. Try again in a moment.'}
  finally{hideBusy()}
}
async function save(){const r=await fetch('/api/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentDraft)});const p=await r.json();currentDraft=p.draft;msg.textContent='Saved draft'}
async function approve(){currentDraft.approvalStatus='Approved';await save();msg.textContent='Draft approved. Publishing actions are now available.';renderDraft()}
async function exportDraft(){const r=await fetch('/api/drafts/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentDraft)});const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(currentDraft.slug||'content-draft')+'.md';a.click();URL.revokeObjectURL(a.href);msg.textContent='Markdown export created'}
async function publishWix(){
  msg.textContent='Publishing to Wix...';
  showBusy('Publishing to Wix','Uploading the image, creating the blog post, and publishing it live.');
  try{
    const r=await fetch('/api/publish/wix-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentDraft)});
    const p=await r.json();
    msg.textContent=p.message||p.error;
    renderDraft('<div class=status>'+esc(p.message||p.error)+'</div><pre>'+esc(JSON.stringify(p.result||p.payload||{},null,2))+'</pre>');
    if(p.ok){loadHistory()}
  }finally{
    hideBusy();
  }
}
async function publishFacebook(){
  showBusy('Preparing Facebook post','Checking the approval and publishing setup.');
  try{
    const r=await fetch('/api/publish/facebook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentDraft)});
    const p=await r.json();
    renderDraft('<div class=status>'+esc(p.message||p.error)+'</div><pre>'+esc(p.facebookPost||'')+'</pre>');
  }finally{
    hideBusy();
  }
}
loadHistory();
`;
}

if (!env.VERCEL) {
  http.createServer(handler).listen(port, "127.0.0.1", () => {
    console.log(`Southtown Content Agent running at http://127.0.0.1:${port}`);
  });
}
