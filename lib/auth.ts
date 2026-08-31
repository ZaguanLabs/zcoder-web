import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "zweb_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  }
  return new TextEncoder().encode(value);
}

export async function createSession(username: string): Promise<string> {
  return new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setIssuer("zweb")
    .setAudience("zweb")
    .sign(secret());
}

export async function verifySession(token?: string): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, secret(), { issuer: "zweb", audience: "zweb" });
    return true;
  } catch {
    return false;
  }
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

