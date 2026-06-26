import { Opportunity } from "./opportunities";

export type ContentDraft = {
  id?: string;
  title: string;
  seoTitle: string;
  metaDescription: string;
  slug: string;
  excerpt: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  outline: string[];
  body: string;
  faq: Array<{ question: string; answer: string }>;
  facebookPost: string;
  safetyNotes: string[];
  approvalStatus: "Draft" | "Ready for review" | "Approved";
  publishStatus?: {
    wix?: "Not sent" | "Ready" | "Created" | "Needs credentials" | "Error";
    facebook?: "Not sent" | "Ready" | "Published" | "Needs credentials" | "Error";
    lastMessage?: string;
  };
  generationSource?: "Template" | "OpenAI";
  createdAt?: string;
  updatedAt?: string;
};

export type SavedContentDraft = ContentDraft & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function sentenceForIntent(query: string) {
  const lower = query.toLowerCase();

  if (lower.includes("gum")) {
    return "healthy gums, early signs of gum irritation, and when a dental check-up may help";
  }

  if (lower.includes("clinic") || lower.includes("dentist")) {
    return "choosing a local dental clinic, what to expect at an appointment, and practical questions to ask";
  }

  return "common dental questions, preventive care, and when to speak with a dentist";
}

export function generateContentDraft(opportunity: Opportunity): ContentDraft {
  const topic = titleCase(opportunity.query);
  const title = topic.toLowerCase().includes("toowoomba")
    ? `${topic}: A Local Patient Guide`
    : `${topic} in Toowoomba: What Patients Should Know`;
  const seoTitle = `${topic} in Toowoomba | Southtown Dental`;
  const metaDescription = `A simple Toowoomba patient guide to ${sentenceForIntent(opportunity.query)}. General information only; book a dental appointment for personal advice.`;
  const slug = slugify(`${opportunity.query}-toowoomba-guide`);
  const secondaryKeywords = [
    "Toowoomba dentist",
    "Southtown Dental Toowoomba",
    "dental care Toowoomba",
    "preventive dental care"
  ];
  const outline = [
    `What "${opportunity.query}" usually means for patients`,
    "Why local context matters in Toowoomba",
    "Common signs or questions patients may have",
    "What happens during a dental appointment",
    "Simple preventive steps patients can take",
    "When to book with Southtown Dental"
  ];
  const body = [
    `# ${title}`,
    "",
    `Many people search for "${opportunity.query}" when they are trying to understand what to do next. This guide gives Toowoomba patients a clear, practical starting point without replacing advice from a dentist who can examine your teeth and gums.`,
    "",
    `## What patients usually want to know`,
    "",
    `Search Console shows this topic has visibility for Southtown Dental, with ${opportunity.impressions} impressions and an average position of ${opportunity.position.toFixed(1)} in the selected date range. That suggests people are already looking for this information, but the page or snippet may need a clearer answer.`,
    "",
    `For patients, the important questions are usually simple: what is normal, what should be watched, and when should a dental appointment be booked. A local dental team can check the mouth directly and explain options based on the patient’s age, dental history, symptoms, and risk factors.`,
    "",
    `## Practical guidance for Toowoomba families`,
    "",
    `Good dental content should help people make informed decisions, not create alarm. For ${sentenceForIntent(opportunity.query)}, the safest message is to encourage regular check-ups, early attention to changes, and a personalised discussion with a dentist if something feels unusual.`,
    "",
    `## What to expect at an appointment`,
    "",
    `At a dental visit, the team may ask about symptoms, medical history, brushing and flossing habits, previous treatment, and any concerns. The dentist can examine the teeth, gums, bite, and soft tissues, then explain whether monitoring, preventive care, hygiene support, or treatment may be suitable.`,
    "",
    `## Simple next steps`,
    "",
    `Patients can usually start with the basics: brush twice daily with fluoride toothpaste, clean between teeth, limit frequent sugary snacks and drinks, and keep regular dental check-ups. If there is pain, swelling, bleeding that does not settle, a broken tooth, or sudden changes, it is sensible to contact a dental clinic promptly.`,
    "",
    `## Book a local dental check-up`,
    "",
    `Southtown Dental Toowoomba can help patients understand their options after an examination. This article is general information only and should not be used as a diagnosis or treatment plan.`
  ].join("\n");

  return {
    title,
    seoTitle,
    metaDescription,
    slug,
    excerpt: metaDescription,
    primaryKeyword: opportunity.query,
    secondaryKeywords,
    outline,
    body,
    faq: [
      {
        question: `Is "${opportunity.query}" something I should ask a dentist about?`,
        answer:
          "Yes, if you have symptoms, concerns, or changes in your mouth. A dentist can examine you and provide advice based on your situation."
      },
      {
        question: "Can this article diagnose my dental problem?",
        answer:
          "No. It is general information only. Diagnosis requires an appointment with a qualified dental professional."
      },
      {
        question: "When should I book sooner rather than waiting?",
        answer:
          "Book promptly if you have dental pain, swelling, bleeding that does not settle, trauma, a broken tooth, or any sudden change that worries you."
      }
    ],
    facebookPost: `New local guide draft: ${title}\n\nPatients often search for "${opportunity.query}" when deciding what to do next. This guide explains the basics in plain language and encourages people to book a dental appointment for personalised advice.\n\nGeneral information only. For dental concerns, contact Southtown Dental Toowoomba.`,
    safetyNotes: [
      "Keep this as general health information, not diagnosis.",
      "Avoid promises such as painless, guaranteed, permanent, or best.",
      "Do not imply a treatment is suitable before a dentist examines the patient.",
      "Mention urgent symptoms carefully and encourage prompt professional care."
    ],
    approvalStatus: "Ready for review",
    publishStatus: {
      wix: "Not sent",
      facebook: "Not sent"
    },
    generationSource: "Template"
  };
}

export async function generateAIDraft(opportunity: Opportunity): Promise<ContentDraft | null> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const fallback = generateContentDraft(opportunity);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      reasoning: { effort: "low" },
      input: [
        {
          role: "developer",
          content: [
            "You are a cautious dental content strategist for an Australian dental clinic.",
            "Write useful SEO content, but do not diagnose, guarantee outcomes, or make treatment claims.",
            "Return JSON only. Do not wrap it in markdown.",
            "Required JSON keys: title, seoTitle, metaDescription, slug, excerpt, outline, body, faq, facebookPost, safetyNotes.",
            "faq must be an array of objects with question and answer. outline and safetyNotes must be arrays of strings."
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
            fallbackShape: fallback
          })
        }
      ]
    })
  });

  if (!response.ok) {
    return fallback;
  }

  const payload = await response.json();
  const text = extractResponseText(payload);

  if (!text) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(text) as Partial<ContentDraft>;

    return {
      ...fallback,
      ...parsed,
      primaryKeyword: opportunity.query,
      secondaryKeywords: parsed.secondaryKeywords || fallback.secondaryKeywords,
      faq: parsed.faq || fallback.faq,
      safetyNotes: parsed.safetyNotes || fallback.safetyNotes,
      approvalStatus: "Ready for review",
      publishStatus: {
        wix: "Not sent",
        facebook: "Not sent"
      },
      generationSource: "OpenAI"
    };
  } catch {
    return fallback;
  }
}

function extractResponseText(payload: any): string {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const chunks: string[] = [];

  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}
