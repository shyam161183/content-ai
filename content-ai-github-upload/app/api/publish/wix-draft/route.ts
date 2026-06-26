import { NextRequest, NextResponse } from "next/server";
import { getConnectorStatus, makeWixDraftPayload } from "@/lib/connectors";

export async function POST(request: NextRequest) {
  const draft = await request.json();

  if (draft.approvalStatus !== "Approved") {
    return NextResponse.json(
      { error: "Approve the draft before preparing it for Wix." },
      { status: 400 }
    );
  }

  const status = getConnectorStatus();
  const payload = makeWixDraftPayload(draft);

  if (!status.wix.configured) {
    return NextResponse.json({
      ok: false,
      status: "Needs credentials",
      message: `Wix credentials missing: ${status.wix.needs.join(", ")}.`,
      payload
    });
  }

  return NextResponse.json({
    ok: true,
    status: "Ready",
    message: "Wix draft payload is ready. The direct Wix Blog API call will be enabled after confirming the site API permissions.",
    payload
  });
}
