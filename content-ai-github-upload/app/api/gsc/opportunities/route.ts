import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { z } from "zod";
import { getOAuthClient, getSiteUrl, parseTokenCookie } from "@/lib/google";
import { GscRow, makeDraftIdeas, scoreOpportunities } from "@/lib/opportunities";

const querySchema = z.object({
  startDate: z.string().default(defaultStartDate),
  endDate: z.string().default(defaultEndDate)
});

function defaultEndDate() {
  return new Date().toISOString().slice(0, 10);
}

function defaultStartDate() {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const tokens = parseTokenCookie(request.cookies.get("google_tokens")?.value);

  if (!tokens) {
    return NextResponse.json({ error: "Google Search Console is not connected." }, { status: 401 });
  }

  const params = querySchema.parse({
    startDate: request.nextUrl.searchParams.get("startDate") || undefined,
    endDate: request.nextUrl.searchParams.get("endDate") || undefined
  });

  try {
    const client = getOAuthClient();
    client.setCredentials(tokens);

    const searchconsole = google.searchconsole({ version: "v1", auth: client });
    const response = await searchconsole.searchanalytics.query({
      siteUrl: getSiteUrl(),
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: ["query", "page"],
        rowLimit: 250,
        startRow: 0
      }
    });

    const rows: GscRow[] =
      response.data.rows?.map((row) => ({
        query: row.keys?.[0] || "",
        page: row.keys?.[1],
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: row.ctr || 0,
        position: row.position || 0
      })) || [];

    const opportunities = scoreOpportunities(rows.filter((row) => row.query));

    return NextResponse.json({
      siteUrl: getSiteUrl(),
      startDate: params.startDate,
      endDate: params.endDate,
      totals: {
        rows: rows.length,
        clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
        impressions: rows.reduce((sum, row) => sum + row.impressions, 0),
        averagePosition:
          rows.length === 0
            ? 0
            : rows.reduce((sum, row) => sum + row.position, 0) / rows.length
      },
      opportunities,
      draftIdeas: makeDraftIdeas(opportunities)
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch Google Search Console opportunities."
      },
      { status: 500 }
    );
  }
}
