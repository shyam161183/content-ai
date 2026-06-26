import { NextRequest, NextResponse } from "next/server";
import { listDrafts, saveDraft } from "@/lib/draftStore";

export async function GET() {
  return NextResponse.json({ drafts: await listDrafts() });
}

export async function POST(request: NextRequest) {
  try {
    const draft = await request.json();
    const saved = await saveDraft(draft);

    return NextResponse.json({ draft: saved });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to save draft."
      },
      { status: 400 }
    );
  }
}
