import { NextRequest, NextResponse } from "next/server";
import { draftToMarkdown } from "@/lib/draftStore";

export async function POST(request: NextRequest) {
  try {
    const draft = await request.json();
    const markdown = draftToMarkdown(draft);

    return new NextResponse(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${draft.slug || "content-draft"}.md"`
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to export draft."
      },
      { status: 400 }
    );
  }
}
