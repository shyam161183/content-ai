# Southtown Content Agent

Prototype dashboard for turning Google Search Console data into draft Wix Blog and Facebook content ideas for Southtown Dental Toowoomba.

## Current Scope

- Google OAuth connection.
- Read-only Google Search Console pull.
- SEO opportunity scoring.
- Draft blog topic queue.
- Draft Facebook post text.
- Manual approval workflow foundation.
- Optional OpenAI draft generation when `OPENAI_API_KEY` is set.

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Configure `.env.local`:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
GSC_SITE_URL=https://www.southtowndentaltoowoomba.com.au/
APP_BASE_URL=http://localhost:3000
WIX_API_KEY=
WIX_SITE_ID=
FACEBOOK_PAGE_ID=
FACEBOOK_PAGE_ACCESS_TOKEN=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5
```

3. Run the dashboard:

```bash
npm run dev:local
```

4. Open:

```text
http://localhost:3000
```

## Google Cloud Requirements

- Google Search Console API enabled.
- OAuth consent screen configured.
- Test user added while the app is in testing mode.
- OAuth client type: Web application.
- Authorized redirect URI:

```text
http://localhost:3000/api/auth/google/callback
```

## Next Milestones

1. Debug the local Next dev-server startup stall.
2. Confirm Wix Blog API permissions, then enable direct draft creation.
3. Add Meta app credentials for Facebook Page publishing.
4. Add scheduling and audit history.
5. Add image generation/selection for Wix cover images and Facebook creative.

## Publishing Connectors

The app blocks publish actions until a draft is marked `Approved`.

Wix currently prepares a draft payload and reports missing credentials. Direct Wix Blog draft creation should be enabled after confirming the site has the correct Wix API permissions.

Facebook Page publishing uses the Graph API `/PAGE_ID/feed` endpoint when `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_ACCESS_TOKEN` are configured.
