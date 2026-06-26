import { google } from "googleapis";

const scopes = ["https://www.googleapis.com/auth/webmasters.readonly"];

export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing Google OAuth environment variables.");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getGoogleAuthUrl() {
  const client = getOAuthClient();

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes
  });
}

export function parseTokenCookie(cookieValue?: string) {
  if (!cookieValue) return null;

  try {
    return JSON.parse(Buffer.from(cookieValue, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function serializeTokenCookie(tokens: unknown) {
  return Buffer.from(JSON.stringify(tokens), "utf8").toString("base64url");
}

export function getSiteUrl() {
  return process.env.GSC_SITE_URL || "https://www.southtowndentaltoowoomba.com.au/";
}
