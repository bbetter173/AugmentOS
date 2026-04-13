/**
 * @fileoverview Hono miniapp photo routes.
 * Handles photo requests from local miniapps (phone-initiated).
 * Mounted at: /api/client/miniapp-photo
 *
 * Two endpoints:
 *   POST /request    — phone requests a photo (mints signed upload URL, sends to glasses)
 *   POST /upload/:requestId — glasses (or BLE fallback) uploads the photo here
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";

import { logger as rootLogger } from "../../../services/logging/pino-logger";
import UserSession from "../../../services/session/UserSession";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "miniapp-photo.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/request", requestPhoto);
app.post("/upload/:requestId", uploadPhoto);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/miniapp-photo/request
 *
 * Phone calls this to initiate a photo capture. Cloud mints a signed upload URL
 * and sends PHOTO_REQUEST to the glasses. Phone just gets { accepted: true, requestId }
 * and waits for phone_photo_ready over the WS.
 *
 * Auth: coreToken (existing phone auth, validated by upstream middleware).
 */
async function requestPhoto(c: AppContext) {
  try {
    const body = await c.req.json<{
      requestId?: string;
      packageName: string;
      size?: string;
      compress?: string;
      saveToGallery?: boolean;
      sound?: boolean;
    }>();

    if (!body.packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const requestId = body.requestId || uuidv4();

    // Get the user session from the request context (set by auth middleware)
    const userSession = c.get("userSession");
    if (!userSession) {
      return c.json({ error: "User session not found — ensure coreToken auth middleware ran" }, 401);
    }

    const result = await userSession.phonePhotoManager.requestPhoto({
      requestId,
      packageName: body.packageName,
      size: body.size,
      compress: body.compress,
      saveToGallery: body.saveToGallery,
      sound: body.sound,
    });

    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Error processing miniapp photo request");

    if (message.includes("not connected") || message.includes("Glasses not connected")) {
      return c.json({ error: message }, 503);
    }

    return c.json({ error: message }, 500);
  }
}

/**
 * POST /api/client/miniapp-photo/upload/:requestId
 *
 * Glasses (direct WiFi) or phone's BlePhotoUploadService (BLE fallback) uploads
 * the captured photo here.
 *
 * Auth: Bearer <uploadToken> (single-use JWT minted during the /request call).
 */
async function uploadPhoto(c: AppContext) {
  try {
    const requestId = c.req.param("requestId");
    if (!requestId) {
      return c.json({ error: "Missing requestId" }, 400);
    }

    // Check for error parameter (BLE fallback failure reporting)
    const errorParam = c.req.query("error");
    if (errorParam) {
      logger.warn({ requestId, error: errorParam }, "Upload error reported from BLE fallback");
      // Try to find the session that owns this request and proactively notify
      const authHeader = c.req.header("authorization");
      const errorToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;

      const allSessions = UserSession.getAllSessions();
      for (const session of allSessions) {
        if (errorToken) {
          const result = session.phonePhotoManager.verifyUploadToken(errorToken);
          if (result && result.requestId === requestId) {
            session.phonePhotoManager.handleUploadError(requestId, errorParam);
            break;
          }
        }
      }
      return c.json({ received: true, error: errorParam });
    }

    // Validate upload token
    const authHeader = c.req.header("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.substring(7);

    // We need to find the right user session to verify the token.
    // The token itself contains the userId, so we can decode it first.
    // NOTE: In production, you'd have a centralized token verification service.
    // For v1, iterate sessions to find the matching one.
    const allSessions = UserSession.getAllSessions();
    let matchedSession = null;
    let tokenPayload = null;

    for (const session of allSessions) {
      const result = session.phonePhotoManager.verifyUploadToken(token);
      if (result && result.requestId === requestId) {
        matchedSession = session;
        tokenPayload = result;
        break;
      }
    }

    if (!matchedSession || !tokenPayload) {
      return c.json({ error: "Invalid or expired upload token" }, 401);
    }

    // Parse the multipart form data to get the photo
    const formData = await c.req.formData();
    const photoFile = formData.get("photo") as File | null;

    if (!photoFile) {
      return c.json({ error: "Missing photo file in form data" }, 400);
    }

    const photoBuffer = Buffer.from(await photoFile.arrayBuffer());
    const mimeType = photoFile.type || "image/jpeg";

    // Upload to R2 (or local storage for dev)
    // For v1, write to local disk. R2 integration is documented in the plan
    // but requires R2 credentials to be configured.
    const fs = await import("fs");
    const path = await import("path");
    const uploadDir = path.join(process.cwd(), "packages", "uploads", "miniapp-photos");

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filename = `${tokenPayload.userId}-${requestId}-${Date.now()}.jpg`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, photoBuffer);

    // Construct the public URL
    const cloudHost = process.env.CLOUD_PUBLIC_HOST_NAME || "localhost:8002";
    const protocol = cloudHost.includes("localhost") ? "http" : "https";
    const photoUrl = `${protocol}://${cloudHost}/api/photos/miniapp/${filename}`;

    logger.info(
      { requestId, filename, size: photoBuffer.length, mimeType },
      "Miniapp photo uploaded successfully",
    );

    // Notify the phone
    matchedSession.phonePhotoManager.handleUploadComplete(
      requestId,
      photoUrl,
      mimeType,
      photoBuffer.length,
    );

    return c.json({ success: true, photoUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, requestId: c.req.param("requestId") }, "Error uploading miniapp photo");
    return c.json({ error: message }, 500);
  }
}

export default app;
