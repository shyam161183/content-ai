import { NextResponse } from "next/server";
import { getConnectorStatus } from "@/lib/connectors";

export async function GET() {
  return NextResponse.json(getConnectorStatus());
}
