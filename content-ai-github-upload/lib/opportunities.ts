export type GscRow = {
  query: string;
  page?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type Opportunity = GscRow & {
  score: number;
  type: "CTR lift" | "Near page one" | "Content cluster";
  draftAngle: string;
};

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function scoreOpportunities(rows: GscRow[]): Opportunity[] {
  return rows
    .map((row) => {
      const ctrPercent = row.ctr * 100;
      const nearPageOne = row.position >= 5 && row.position <= 20;
      const lowCtr = row.impressions >= 20 && ctrPercent < 3;
      const cluster = row.impressions >= 10 && row.clicks <= 2;

      const score =
        row.impressions * 0.6 +
        Math.max(0, 25 - row.position) * 8 +
        (lowCtr ? 80 : 0) +
        (nearPageOne ? 60 : 0) +
        (cluster ? 30 : 0);

      const type: Opportunity["type"] = lowCtr
        ? "CTR lift"
        : nearPageOne
          ? "Near page one"
          : "Content cluster";

      return {
        ...row,
        score,
        type,
        draftAngle: makeDraftAngle(row.query, type)
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

export function makeDraftAngle(query: string, type: Opportunity["type"]) {
  const topic = titleCase(query);

  if (type === "CTR lift") {
    return `Refresh or create a clear local answer around "${topic}" with a stronger title, meta description, and patient-focused FAQ section.`;
  }

  if (type === "Near page one") {
    return `Build a practical Toowoomba-focused guide for "${topic}" and link it to the most relevant service page.`;
  }

  return `Create an educational blog cluster article answering common patient questions about "${topic}".`;
}

export function makeDraftIdeas(opportunities: Opportunity[]) {
  return opportunities.slice(0, 5).map((opportunity) => ({
    title: blogTitleForQuery(opportunity.query),
    primaryKeyword: opportunity.query,
    rationale: opportunity.draftAngle,
    facebookPost: `Patients often search for "${opportunity.query}" when they are deciding what to do next. We are preparing a simple local guide to help Toowoomba families understand their options and know when to book an appointment.`
  }));
}

function blogTitleForQuery(query: string) {
  const topic = titleCase(query);

  if (query.toLowerCase().includes("toowoomba")) {
    return `${topic}: A Local Patient Guide`;
  }

  return `${topic} in Toowoomba: What Patients Should Know`;
}
