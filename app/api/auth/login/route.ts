import argon2 from "argon2";
import { NextRequest, NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { clearLoginFailures, loginLimit, recordLoginFailure } from "@/lib/rate-limit";
import { clientAddress, hasSameOrigin } from "@/lib/security";
import { BodyError, readBoundedForm, readBoundedJson } from "@/lib/request";

function formRedirect(request: NextRequest, error?: string) {
  const base = process.env.APP_ORIGIN || request.nextUrl.origin;
  return NextResponse.redirect(new URL(error ? `/login?error=${error}` : "/", base), 303);
}

export async function POST(request: NextRequest) {
  const formSubmission = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") === true;
  if (!hasSameOrigin(request)) {
    return formSubmission ? formRedirect(request, "origin") : NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  const address = clientAddress(request);
  const limit = loginLimit(address);
  if (!limit.allowed) {
    if (formSubmission) return formRedirect(request, "locked");
    return NextResponse.json({ error: `Too many attempts. Try again in ${limit.retryAfter} seconds.` }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  }
  const expectedUsername = process.env.APP_USERNAME;
  const passwordHash = process.env.APP_PASSWORD_HASH;
  if (!expectedUsername || !passwordHash) {
    return formSubmission ? formRedirect(request, "config") : NextResponse.json({ error: "Login is not configured" }, { status: 503 });
  }
  let input: unknown;
  try { input = formSubmission ? await readBoundedForm(request, 2_048) : await readBoundedJson(request, 2_048); } catch (error) {
    if (formSubmission) return formRedirect(request, "request");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: error instanceof BodyError ? error.status : 400 });
  }
  const candidate = input as { username?: unknown; password?: unknown };
  const username = typeof candidate?.username === "string" ? candidate.username : "";
  const password = typeof candidate?.password === "string" ? candidate.password : "";
  const passwordOk = password.length <= 512 && await argon2.verify(passwordHash, password).catch(() => false);
  if (username !== expectedUsername || !passwordOk) {
    recordLoginFailure(address);
    if (formSubmission) return formRedirect(request, "credentials");
    return NextResponse.json({ error: "Username or password is incorrect" }, { status: 401 });
  }
  clearLoginFailures(address);
  const response = formSubmission ? formRedirect(request) : NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSession(username), sessionCookieOptions);
  return response;
}
