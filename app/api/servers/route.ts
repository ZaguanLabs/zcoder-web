import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { getServers } from "@/lib/zcoder";

export async function GET(request: NextRequest) {
  if (!await verifySession(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: { "X-Zweb-Auth": "required" } });
  }
  try {
    return NextResponse.json(getServers().map(({ id, name }) => ({ id, name })));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Server configuration is invalid" }, { status: 500 });
  }
}
