import { NextRequest, NextResponse } from "next/server";
import { getOAuthClient, serializeTokenCookie } from "@/lib/google";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const appBaseUrl = process.env.APP_BASE_URL || "http://localhost:3000";

  if (!code) {
    return NextResponse.redirect(`${appBaseUrl}/?error=missing_google_code`);
  }

  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    const response = NextResponse.redirect(`${appBaseUrl}/?connected=google`);

    response.cookies.set("google_tokens", serializeTokenCookie(tokens), {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });

    return response;
  } catch {
    return NextResponse.redirect(`${appBaseUrl}/?error=google_auth_failed`);
  }
}
