import "dotenv/config";
import { db, requireMockMode } from "../server/db";
import { runOnce } from "./jobs";

async function main() {
  requireMockMode();
  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; });
  process.on("SIGINT", () => { stopped = true; });
  let nextCleanup = 0;
  while (!stopped) {
    try {
      if (Date.now() >= nextCleanup) {
        await db.rateLimit.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86400000) } } });
        await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        nextCleanup = Date.now() + 3600000;
      }
      if (!await runOnce()) await new Promise(resolve => setTimeout(resolve, 1000));
    } catch {
      console.error(JSON.stringify({ code: "WORKER_DATABASE_UNAVAILABLE" }));
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  await db.$disconnect();
}
main().catch(() => { console.error("WORKER_START_BLOCKED"); process.exitCode = 1; });
