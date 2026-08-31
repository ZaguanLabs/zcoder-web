import { NextRequest } from "next/server";

export function hasSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const configured = process.env.APP_ORIGIN?.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production" && !configured) return false;
  return origin === (configured || request.nextUrl.origin);
}

export function clientAddress(request: NextRequest): string {
  if (process.env.TRUST_PROXY_HEADERS !== "true") return "untrusted-network";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown-proxy-client";
}
