import { NextRequest, NextResponse } from "next/server";
import { publishFacebookPost } from "@/lib/connectors";

export async function POST(request: NextRequest) {
  const draft = await request.json();

  if (draft.approvalStatus !== "Approved") {
    return NextResponse.json(
      { error: "Approve the draft before publishing to Facebook." },
      { status: 400 }
    );
  }

  const result = await publishFacebookPost(draft);

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
