-- CreateTable
CREATE TABLE "TryOnResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "artifact" TEXT,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "sourceResultId" TEXT,
    "productTitle" TEXT,
    "placement" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TryOnResult_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TryOnResult_conversationId_idx" ON "TryOnResult"("conversationId");

-- CreateIndex
CREATE INDEX "TryOnResult_type_idx" ON "TryOnResult"("type");
