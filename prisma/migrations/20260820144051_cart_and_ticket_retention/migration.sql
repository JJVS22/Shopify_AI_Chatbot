-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "cartId" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SupportTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "summary" TEXT NOT NULL,
    "details" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "orderRef" TEXT,
    "callTime" DATETIME,
    "contactPhone" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupportTicket_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SupportTicket" ("callTime", "contactPhone", "conversationId", "createdAt", "customerEmail", "customerName", "details", "id", "orderRef", "status", "summary", "type", "updatedAt") SELECT "callTime", "contactPhone", "conversationId", "createdAt", "customerEmail", "customerName", "details", "id", "orderRef", "status", "summary", "type", "updatedAt" FROM "SupportTicket";
DROP TABLE "SupportTicket";
ALTER TABLE "new_SupportTicket" RENAME TO "SupportTicket";
CREATE INDEX "SupportTicket_conversationId_idx" ON "SupportTicket"("conversationId");
CREATE INDEX "SupportTicket_status_idx" ON "SupportTicket"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
