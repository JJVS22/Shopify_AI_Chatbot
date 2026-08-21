import {
  findExpiredConversationIds,
  getTryOnFilePathsForConversations,
  deleteConversations,
} from "../db.server";
import { deleteTryonResultFile } from "./providers/storage.server";

/**
 * Delete conversations (and their messages, try-on result rows, and result
 * files on disk) that have had no activity for `maxAgeHours` hours.
 * @param {number} maxAgeHours
 * @returns {Promise<{deletedConversations: number, deletedFiles: number}>}
 */
export async function runCleanup(maxAgeHours = 24) {
  const before = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

  const expiredIds = await findExpiredConversationIds(before);
  if (expiredIds.length === 0) return { deletedConversations: 0, deletedFiles: 0 };

  const filePaths = await getTryOnFilePathsForConversations(expiredIds);

  for (const filePath of filePaths) {
    try {
      await deleteTryonResultFile(filePath);
    } catch (err) {
      console.error("[Cleanup] Failed to delete try-on file:", filePath, err.message);
    }
  }

  const count = await deleteConversations(expiredIds);
  console.log(
    `[Cleanup] Deleted ${count} expired conversation(s) and ${filePaths.length} try-on file(s) (older than ${maxAgeHours}h)`
  );

  return { deletedConversations: count, deletedFiles: filePaths.length };
}

/**
 * Run one cleanup immediately (fire-and-forget) and then on an interval.
 * @param {{maxAgeHours?: number, intervalMs?: number}} [opts]
 */
export function startCleanupScheduler({
  maxAgeHours = 24,
  intervalMs = 30 * 60 * 1000,
} = {}) {
  const run = () => {
    runCleanup(maxAgeHours).catch((err) => {
      console.error("[Cleanup] scheduler run failed:", err);
    });
  };

  // First sweep shortly after boot (non-blocking).
  setTimeout(run, 5_000);
  // Then every interval.
  const id = setInterval(run, intervalMs);
  // Don't keep the process alive purely for the timer in serverless contexts.
  if (typeof id.unref === "function") id.unref();

  return id;
}

export default {
  runCleanup,
  startCleanupScheduler,
};
