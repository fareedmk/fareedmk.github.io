import { Prisma, PrismaClient } from "@prisma/client";

const globalDb = globalThis as unknown as { db?: PrismaClient };
export const db = globalDb.db ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalDb.db = db;

export function requireMockMode(): "mock" {
  const mode = process.env.CLOVER_MODE ?? "mock";
  if (mode !== "mock") throw new Error("LIVE_INTEGRATION_BLOCKED");
  return "mock";
}

export const locationId = () => process.env.LOCATION_ID || "yafi-main";

export async function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(fn, { isolationLevel: "Serializable" });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !["P2034", "P2002"].includes(error.code) || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 50 * (attempt + 1)));
    }
  }
}
