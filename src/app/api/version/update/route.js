import { NextResponse } from "next/server";
import { forkSyncStatus, startForkSync } from "@/lib/forkSync";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(forkSyncStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  try {
    return NextResponse.json(startForkSync(), { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
}
