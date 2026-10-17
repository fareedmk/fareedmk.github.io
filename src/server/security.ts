import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db, requireMockMode } from "./db";

export class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const ownerHash = (request: NextRequest) => hash(request.cookies.get("ordering_owner")?.value ?? "");
export const jsonValue = <T>(value: unknown): T => value as T;

export function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const expected = process.env.APP_ORIGIN ?? request.nextUrl.origin;
  if (!origin || origin !== expected) throw new HttpError(403, "ORIGIN_REJECTED");
}

export async function rateLimit(request: NextRequest, action: string, maximum = 60) {
  // Do not trust client-supplied forwarding headers. The shared fallback also limits untrusted proxies.
  const identity = action === "admin-login" ? "shared" : request.cookies.get("ordering_owner")?.value ?? "shared";
  const bucket = Math.floor(Date.now() / 60000);
  const id = hash(`${action}:${identity}:${bucket}`);
  const result = await db.rateLimit.upsert({
    where: { id }, create: { id, count: 1, expiresAt: new Date((bucket + 1) * 60000) },
    update: { count: { increment: 1 } },
  });
  if (result.count > maximum) throw new HttpError(429, "RATE_LIMITED");
  if (identity !== "shared") {
    const globalId = hash(`${action}:global:${bucket}`);
    const global = await db.rateLimit.upsert({
      where: { id: globalId }, create: { id: globalId, count: 1, expiresAt: new Date((bucket + 1) * 60000) },
      update: { count: { increment: 1 } },
    });
    if (global.count > maximum * 10) throw new HttpError(429, "RATE_LIMITED");
  }
}

export async function requireAdmin(request: NextRequest) {
  if (!["GET", "HEAD"].includes(request.method)) sameOrigin(request);
  const value = request.cookies.get("ordering_admin")?.value;
  if (!value) throw new HttpError(401, "UNAUTHORIZED");
  const session = await db.session.findUnique({ where: { id: hash(value) } });
  if (!session || session.role !== "owner" || session.expiresAt <= new Date()) throw new HttpError(401, "UNAUTHORIZED");
  return session;
}

export function passwordHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password: string, encoded: string): boolean {
  const [salt, digest] = encoded.split(":");
  const expected = Buffer.from(digest, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function route(handler: (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<NextResponse>) {
  return async (request: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    const correlationId = token().slice(0, 16);
    try {
      requireMockMode();
      const response = await handler(request, context);
      response.headers.set("x-correlation-id", correlationId);
      response.headers.set("cache-control", "no-store");
      return response;
    } catch (error) {
      const blocked = error instanceof Error && error.message === "LIVE_INTEGRATION_BLOCKED";
      const status = error instanceof HttpError ? error.status : blocked ? 503 : 500;
      const code = error instanceof HttpError ? error.code : blocked ? "INTEGRATION_BLOCKED" : "INTERNAL_ERROR";
      const messages: Record<string, string> = {
        PRICE_CHANGED: "The menu or promotion changed. Please request a fresh quote.",
        AVAILABILITY_CHANGED: "An item, promotion, or pickup slot is no longer available. Please request a fresh quote.",
        INTERNAL_ERROR: "The request could not be completed. Please try again.",
        INTEGRATION_BLOCKED: "Only mock mode is available. Live integrations are blocked.",
        PROMOTION_IN_USE: "This promotion has quote or order history. Disable it instead of deleting it.",
      };
      const message = messages[code] ?? code.toLowerCase().replaceAll("_", " ").replace(/^./, value => value.toUpperCase()) + ".";
      console.error(JSON.stringify({ correlationId, code }));
      return NextResponse.json({ error: { code, message, correlationId } }, {
        status, headers: { "cache-control": "no-store", "x-correlation-id": correlationId },
      });
    }
  };
}

export async function body(request: NextRequest): Promise<unknown> {
  if (Number(request.headers.get("content-length") || 0) > 32768) throw new HttpError(413, "BODY_TOO_LARGE");
  const text = await request.text();
  if (Buffer.byteLength(text) > 32768) throw new HttpError(413, "BODY_TOO_LARGE");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "INVALID_REQUEST"); }
}
