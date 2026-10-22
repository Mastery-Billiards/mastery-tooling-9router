import { forkVersionStatus } from "@/lib/forkVersion";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request) {
  return Response.json(await forkVersionStatus({ refresh: new URL(request.url).searchParams.get("refresh") === "1" }), { headers: { "Cache-Control": "no-store" } });
}
