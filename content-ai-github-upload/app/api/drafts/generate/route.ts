import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateAIDraft, generateContentDraft } from "@/lib/drafts";
import { Opportunity } from "@/lib/opportunities";

const opportunitySchema = z.object({
  query: z.string(),
  page: z.string().optional(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
  score: z.number(),
  type: z.enum(["CTR lift", "Near page one", "Content cluster"]),
  draftAngle: z.string()
});

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const opportunity = opportunitySchema.parse(payload.opportunity) as Opportunity;

    const draft = (await generateAIDraft(opportunity)) || generateContentDraft(opportunity);

    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to generate content draft."
      },
      { status: 400 }
    );
  }
}
