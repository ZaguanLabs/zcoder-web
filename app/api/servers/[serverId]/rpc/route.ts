import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { runRpc } from "@/lib/rpc";
import { hasSameOrigin } from "@/lib/security";
import { findServer, ZcoderError } from "@/lib/zcoder";
import { BodyError, readBoundedJson } from "@/lib/request";

export async function POST(request: NextRequest, context: { params: Promise<{ serverId: string }> }) {
  if (!await verifySession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!hasSameOrigin(request)) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  try {
    const input = await readBoundedJson(request, 1_000_000);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ZcoderError("Invalid request", 400);
    const { serverId } = await context.params;
    const data = await runRpc(findServer(serverId), input as Record<string, unknown>);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof ZcoderError || error instanceof BodyError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Request failed" }, { status });
  }
}
