import { NextResponse } from "next/server";
import { getGoogleAuthUrl } from "@/lib/google";

export async function GET() {
  try {
    return NextResponse.redirect(getGoogleAuthUrl());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to start Google OAuth." },
      { status: 500 }
    );
  }
}
