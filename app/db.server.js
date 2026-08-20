import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;

/**
 * Store a code verifier for PKCE authentication
 * @param {string} state - The state parameter used in OAuth flow
 * @param {string} verifier - The code verifier to store
 * @returns {Promise<Object>} - The saved code verifier object
 */
export async function storeCodeVerifier(state, verifier) {
  // Calculate expiration date (10 minutes from now)
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 10);

  try {
    return await prisma.codeVerifier.create({
      data: {
        id: `cv_${Date.now()}`,
        state,
        verifier,
        expiresAt
      }
    });
  } catch (error) {
    console.error('Error storing code verifier:', error);
    throw error;
  }
}

/**
 * Get a code verifier by state parameter
 * @param {string} state - The state parameter used in OAuth flow
 * @returns {Promise<Object|null>} - The code verifier object or null if not found
 */
export async function getCodeVerifier(state) {
  try {
    const verifier = await prisma.codeVerifier.findFirst({
      where: {
        state,
        expiresAt: {
          gt: new Date()
        }
      }
    });

    if (verifier) {
      // Delete it after retrieval to prevent reuse
      await prisma.codeVerifier.delete({
        where: {
          id: verifier.id
        }
      });
    }

    return verifier;
  } catch (error) {
    console.error('Error retrieving code verifier:', error);
    return null;
  }
}

/**
 * Store a customer access token in the database
 * @param {string} conversationId - The conversation ID to associate with the token
 * @param {string} accessToken - The access token to store
 * @param {Date} expiresAt - When the token expires
 * @returns {Promise<Object>} - The saved customer token
 */
export async function storeCustomerToken(conversationId, accessToken, expiresAt) {
  try {
    // Check if a token already exists for this conversation
    const existingToken = await prisma.customerToken.findFirst({
      where: { conversationId }
    });

    if (existingToken) {
      // Update existing token
      return await prisma.customerToken.update({
        where: { id: existingToken.id },
        data: {
          accessToken,
          expiresAt,
          updatedAt: new Date()
        }
      });
    }

    // Create a new token record
    return await prisma.customerToken.create({
      data: {
        id: `ct_${Date.now()}`,
        conversationId,
        accessToken,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Error storing customer token:', error);
    throw error;
  }
}

/**
 * Get a customer access token by conversation ID
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Object|null>} - The customer token or null if not found/expired
 */
export async function getCustomerToken(conversationId) {
  try {
    const token = await prisma.customerToken.findFirst({
      where: {
        conversationId,
        expiresAt: {
          gt: new Date() // Only return non-expired tokens
        }
      }
    });

    return token;
  } catch (error) {
    console.error('Error retrieving customer token:', error);
    return null;
  }
}

/**
 * Create or update a conversation in the database
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Object>} - The created or updated conversation
 */
export async function createOrUpdateConversation(conversationId) {
  try {
    const existingConversation = await prisma.conversation.findUnique({
      where: { id: conversationId }
    });

    if (existingConversation) {
      return await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          updatedAt: new Date()
        }
      });
    }

    return await prisma.conversation.create({
      data: {
        id: conversationId
      }
    });
  } catch (error) {
    console.error('Error creating/updating conversation:', error);
    throw error;
  }
}

/**
 * Save a message to the database
 * @param {string} conversationId - The conversation ID
 * @param {string} role - The message role (user or assistant)
 * @param {string} content - The message content
 * @returns {Promise<Object>} - The saved message
 */
export async function saveMessage(conversationId, role, content) {
  try {
    // Ensure the conversation exists
    await createOrUpdateConversation(conversationId);

    // Create the message
    return await prisma.message.create({
      data: {
        conversationId,
        role,
        content
      }
    });
  } catch (error) {
    console.error('Error saving message:', error);
    throw error;
  }
}

/**
 * Get conversation history
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Array>} - Array of messages in the conversation
 */
export async function getConversationHistory(conversationId) {
  try {
    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' }
    });

    return messages;
  } catch (error) {
    console.error('Error retrieving conversation history:', error);
    return [];
  }
}

/**
 * Store customer account URLs for a conversation
 * @param {string} conversationId - The conversation ID
 * @param {string} mcpApiUrl - The customer account MCP URL
 * @param {string} authorizationUrl - The customer account authorization URL
 * @param {string} tokenUrl - The customer account token URL
 * @returns {Promise<Object>} - The saved urls object
 */
export async function storeCustomerAccountUrls({conversationId, mcpApiUrl, authorizationUrl, tokenUrl}) {
  try {
    return await prisma.customerAccountUrls.upsert({
      where: { conversationId },
      create: {
        conversationId,
        mcpApiUrl,
        authorizationUrl,
        tokenUrl,
        updatedAt: new Date(),
      },
      update: {
        mcpApiUrl,
        authorizationUrl,
        tokenUrl,
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    console.error('Error storing customer account URLs:', error);
    throw error;
  }
}

/**
 * Get customer account URLs for a conversation
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Object|null>} - The customer account URLs or null if not found
 */
export async function getCustomerAccountUrls(conversationId) {
  try {
    return await prisma.customerAccountUrls.findUnique({
      where: { conversationId }
    });
  } catch (error) {
    console.error('Error retrieving customer account URLs:', error);
    return null;
  }
}

/**
 * Record a try-on result (2D image / 3D glb or mp4) linked to a conversation.
 * @param {object} data - { conversationId, type, artifact, fileName, filePath, publicUrl, sourceResultId?, productTitle?, placement?, provider?, model? }
 * @returns {Promise<Object>} The saved TryOnResult
 */
export async function saveTryonResultRecord(data) {
  const { conversationId, type, artifact, fileName, filePath, publicUrl } = data;
  if (!conversationId || !type || !fileName || !filePath || !publicUrl) {
    throw new Error('saveTryonResultRecord requires conversationId, type, fileName, filePath, publicUrl');
  }

  await createOrUpdateConversation(conversationId);

  return await prisma.tryOnResult.create({
    data: {
      conversationId,
      type,
      artifact: artifact || null,
      fileName,
      filePath,
      publicUrl,
      sourceResultId: data.sourceResultId || null,
      productTitle: data.productTitle || null,
      placement: data.placement || null,
      provider: data.provider || null,
      model: data.model || null,
    },
  });
}

/**
 * Get all try-on results for a conversation.
 * @param {string} conversationId
 * @returns {Promise<Array>} Ordered try-on results
 */
export async function getTryOnResultsByConversation(conversationId) {
  try {
    return await prisma.tryOnResult.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  } catch (error) {
    console.error('Error retrieving try-on results:', error);
    return [];
  }
}

/**
 * Find a try-on result by its public URL (used to link 3D back to its 2D source).
 * @param {string} publicUrl
 * @returns {Promise<Object|null>}
 */
export async function getTryOnResultByPublicUrl(publicUrl) {
  try {
    return await prisma.tryOnResult.findFirst({ where: { publicUrl } });
  } catch (error) {
    console.error('Error finding try-on result by URL:', error);
    return null;
  }
}

/**
 * Find conversation ids with no activity since `before`.
 * @param {Date} before
 * @returns {Promise<Array<string>>}
 */
export async function findExpiredConversationIds(before) {
  try {
    const rows = await prisma.conversation.findMany({
      where: { updatedAt: { lt: before } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  } catch (error) {
    console.error('Error finding expired conversations:', error);
    return [];
  }
}

/**
 * Get try-on result file paths for a set of conversation ids (for cleanup).
 * @param {Array<string>} conversationIds
 * @returns {Promise<Array<string>>} filePath list
 */
export async function getTryOnFilePathsForConversations(conversationIds) {
  try {
    const rows = await prisma.tryOnResult.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { filePath: true },
    });
    return rows.map((r) => r.filePath);
  } catch (error) {
    console.error('Error getting try-on file paths:', error);
    return [];
  }
}

/**
 * Delete conversations (cascades to Message + TryOnResult rows).
 * @param {Array<string>} conversationIds
 * @returns {Promise<number>} number deleted
 */
export async function deleteConversations(conversationIds) {
  try {
    const result = await prisma.conversation.deleteMany({
      where: { id: { in: conversationIds } },
    });
    return result.count;
  } catch (error) {
    console.error('Error deleting conversations:', error);
    return 0;
  }
}

/**
 * Create a support ticket (Layer 3 — human CS / merchant-gated).
 * @param {object} data - { conversationId, type, summary, details?, customerName?, customerEmail?, orderRef?, callTime?, contactPhone? }
 * @returns {Promise<Object>} The saved SupportTicket
 */
export async function createSupportTicket(data) {
  const { conversationId, type, summary } = data;
  if (!conversationId || !type || !summary) {
    throw new Error('createSupportTicket requires conversationId, type, summary');
  }

  await createOrUpdateConversation(conversationId);

  return await prisma.supportTicket.create({
    data: {
      conversationId,
      type,
      summary,
      details: data.details || null,
      customerName: data.customerName || null,
      customerEmail: data.customerEmail || null,
      orderRef: data.orderRef || null,
      callTime: data.callTime ? new Date(data.callTime) : null,
      contactPhone: data.contactPhone || null,
    },
  });
}

/**
 * List support tickets (optionally filtered by status).
 * @param {string} [status] - "open" | "in_progress" | "resolved" | "closed"
 * @returns {Promise<Array>}
 */
export async function listSupportTickets(status) {
  try {
    return await prisma.supportTicket.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
    });
  } catch (error) {
    console.error('Error listing support tickets:', error);
    return [];
  }
}

/**
 * Update a support ticket's status (merchant action).
 * @param {string} id
 * @param {string} status - "open" | "in_progress" | "resolved" | "closed"
 * @returns {Promise<Object|null>} Updated ticket or null if not found
 */
export async function updateSupportTicketStatus(id, status) {
  try {
    return await prisma.supportTicket.update({
      where: { id },
      data: { status, updatedAt: new Date() },
    });
  } catch (error) {
    console.error('Error updating support ticket:', error);
    return null;
  }
}

/**
 * Delete a support ticket (merchant action).
 * @param {string} id
 * @returns {Promise<boolean>} true if a ticket was deleted
 */
export async function deleteSupportTicket(id) {
  try {
    const result = await prisma.supportTicket.delete({ where: { id } });
    return Boolean(result);
  } catch (error) {
    console.error('Error deleting support ticket:', error);
    return false;
  }
}

/**
 * Get the most recent customer-uploaded image URL for a conversation.
 * Uploaded images are stored as messages with role "user_image".
 * @param {string} conversationId
 * @returns {Promise<string|null>}
 */
export async function getLatestUploadedImage(conversationId) {
  try {
    const message = await prisma.message.findFirst({
      where: { conversationId, role: "user_image" },
      orderBy: { createdAt: "desc" },
    });
    return message?.content || null;
  } catch (error) {
    console.error("Error getting latest uploaded image:", error);
    return null;
  }
}

/**
 * Get the persisted guest cart id for a conversation ("" if none yet).
 * @param {string} conversationId
 * @returns {Promise<string|null>}
 */
export async function getCartId(conversationId) {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { cartId: true },
    });
    return conversation?.cartId || null;
  } catch (error) {
    console.error('Error getting cart id:', error);
    return null;
  }
}

/**
 * Persist the guest cart id for a conversation so the same cart is reused
 * across turns (add_to_cart → get_cart_summary → checkout).
 * @param {string} conversationId
 * @param {string} cartId
 * @returns {Promise<void>}
 */
export async function setCartId(conversationId, cartId) {
  try {
    await createOrUpdateConversation(conversationId);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { cartId, updatedAt: new Date() },
    });
  } catch (error) {
    console.error('Error saving cart id:', error);
  }
}

/**
 * Get cached shop metadata.
 * @param {string} shopDomain
 * @returns {Promise<Object|null>}
 */
export async function getShopMeta(shopDomain) {
  try {
    return await prisma.shopMeta.findUnique({ where: { id: shopDomain } });
  } catch (error) {
    console.error('Error getting shop meta:', error);
    return null;
  }
}

/**
 * Upsert cached shop metadata.
 * @param {string} shopDomain
 * @param {object} data
 * @returns {Promise<Object>}
 */
export async function upsertShopMeta(shopDomain, data) {
  try {
    return await prisma.shopMeta.upsert({
      where: { id: shopDomain },
      create: { id: shopDomain, ...data, updatedAt: new Date() },
      update: { ...data, updatedAt: new Date() },
    });
  } catch (error) {
    console.error('Error upserting shop meta:', error);
    return null;
  }
}
