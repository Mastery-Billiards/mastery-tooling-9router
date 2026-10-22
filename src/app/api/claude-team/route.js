import { teamView, configureTeam, discoverTeam, checkTeam } from "@/lib/claudeTeam/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(await teamView(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  try {
    const body = await request.json();
    let data;
    if (body.action === "configure") data = await configureTeam(body);
    else if (body.action === "discover") data = await discoverTeam();
    else if (body.action === "check") data = await checkTeam({ inspect: true, onlyConnectionId: body.connectionId || null });
    else if (body.action === "run") data = await checkTeam({ inspect: false });
    else return Response.json({ error: "Unknown action" }, { status: 400 });
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return Response.json({ error: e.message }, { status: 409 }); }
}
