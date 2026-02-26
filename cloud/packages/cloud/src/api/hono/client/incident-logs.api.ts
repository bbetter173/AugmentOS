/**
 * @fileoverview Hono incident API routes.
 * Endpoints for creating incidents and uploading logs/attachments.
 * Mounted at: /api/incidents
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { incidentStorage, LogEntry } from "../../../services/storage/incident-storage.service";
import { Incident } from "../../../models/incident.model";
import appService from "../../../services/core/app.service";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { queueIncidentProcessing } from "../../../services/incidents/incident-processor.service";
import type { AppEnv } from "../../../types/hono";
import type { FeedbackData, PhoneStateSnapshot } from "../../../types/feedback.types";

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

const logger = rootLogger.child({ service: "incidents.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Create Incident
// ============================================================================

/**
 * POST /api/incidents
 * Create a new incident for a bug report.
 *
 * Auth: Authorization: Bearer <coreToken>
 *
 * Body:
 * {
 *   "feedback": { type: "bug", expectedBehavior, actualBehavior, severityRating, systemInfo, ... },
 *   "phoneState": { ... } // Optional snapshot of phone state
 * }
 *
 * Returns: { success: true, incidentId: string }
 */
app.post("/", async (c) => {
  // Auth - coreToken required
  const authHeader = c.req.header("Authorization");
  const coreToken = authHeader?.replace("Bearer ", "");

  if (!coreToken) {
    return c.json({ success: false, message: "Missing authentication" }, 401);
  }

  let userEmail: string;
  try {
    const decoded = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
    if (!decoded || !decoded.email) {
      return c.json({ success: false, message: "Invalid token" }, 401);
    }
    userEmail = decoded.email;
  } catch {
    return c.json({ success: false, message: "Invalid token" }, 401);
  }

  // Parse body
  let body: { feedback: FeedbackData; phoneState?: PhoneStateSnapshot };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: "Invalid JSON body" }, 400);
  }

  // Validate feedback
  if (!body.feedback || typeof body.feedback !== "object") {
    return c.json({ success: false, message: "Missing feedback data" }, 400);
  }

  if (body.feedback.type !== "bug") {
    return c.json({ success: false, message: "Incidents are only for bug reports" }, 400);
  }

  // Generate incident ID
  const incidentId = uuidv4();

  try {
    // Store initial incident data to R2
    await incidentStorage.storeIncidentLogs(incidentId, {
      incidentId,
      createdAt: new Date().toISOString(),
      feedback: body.feedback as unknown as Record<string, unknown>,
      phoneState: (body.phoneState || {}) as Record<string, unknown>,
      phoneLogs: [], // Populated via POST /api/incidents/:id/logs
      cloudLogs: [], // Populated by background job
      glassesLogs: [], // Populated async via same endpoint
      appTelemetryLogs: {}, // Populated via same endpoint, keyed by package name
    });

    // Create incident record in MongoDB
    await Incident.create({
      incidentId,
      userId: userEmail,
      status: "processing",
    });

    logger.info({ incidentId, userId: userEmail }, "Created incident for bug report");

    // Queue background processing (cloud logs, Linear, notifications)
    queueIncidentProcessing(incidentId, userEmail);

    return c.json({ success: true, incidentId });
  } catch (err) {
    logger.error({ error: err, incidentId, userId: userEmail }, "Failed to create incident");
    return c.json({ success: false, message: "Failed to create incident" }, 500);
  }
});

// ============================================================================
// Upload Logs
// ============================================================================

/**
 * POST /api/incidents/:incidentId/logs
 * Upload logs to an incident.
 *
 * Auth (accepts first match):
 * - Phone/Glasses: Authorization: Bearer <coreToken>
 * - Miniapps: X-App-Api-Key: <apiKey> + X-App-Package: <packageName>
 *
 * Body:
 * {
 *   "source": "phone" | "glasses" | omit for apps,
 *   "logs": [{ timestamp, level, message, source?, metadata? }]
 * }
 */
app.post("/:incidentId/logs", async (c) => {
  const incidentId = c.req.param("incidentId");
  let source: string;
  let logCategory: "phoneLogs" | "glassesLogs" | null = null;
  let appPackageName: string | null = null;
  let userEmail: string | null = null;

  // Parse body first
  let body: { source?: string; logs: LogEntry[]; uploadToken?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: "Invalid JSON body" }, 400);
  }

  // Validate logs array
  if (!body.logs || !Array.isArray(body.logs)) {
    return c.json({ success: false, message: "Invalid payload: logs array required" }, 400);
  }

  // Check auth - try coreToken first, then app auth with uploadToken
  const authHeader = c.req.header("Authorization");
  const coreToken = authHeader?.replace("Bearer ", "");

  if (coreToken) {
    // Phone or glasses auth
    try {
      const decoded = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
      if (!decoded || !decoded.email) {
        return c.json({ success: false, message: "Invalid token" }, 401);
      }
      userEmail = decoded.email;
      source = body.source || "phone";
      logCategory = source === "glasses" ? "glassesLogs" : "phoneLogs";
    } catch {
      return c.json({ success: false, message: "Invalid token" }, 401);
    }
  } else {
    // Check app auth (apiKey + uploadToken)
    const apiKey = c.req.header("X-App-Api-Key");
    const packageName = c.req.header("X-App-Package");

    if (!apiKey || !packageName) {
      return c.json({ success: false, message: "Missing authentication" }, 401);
    }

    const isValid = await appService.validateApiKey(packageName, apiKey);
    if (!isValid) {
      return c.json({ success: false, message: "Invalid app credentials" }, 401);
    }

    // Validate uploadToken for app telemetry uploads
    if (!body.uploadToken) {
      return c.json({ success: false, message: "Missing uploadToken for app telemetry" }, 401);
    }

    try {
      const tokenData = jwt.verify(body.uploadToken, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
      if (!tokenData || tokenData.incidentId !== incidentId || tokenData.packageName !== packageName) {
        return c.json({ success: false, message: "Invalid uploadToken" }, 401);
      }
      userEmail = tokenData.userId;
    } catch {
      return c.json({ success: false, message: "Invalid or expired uploadToken" }, 401);
    }

    source = packageName;
    appPackageName = packageName;
  }

  // Check if incident exists and verify ownership
  const incident = await Incident.findOne({ incidentId });
  if (!incident) {
    return c.json({ success: false, message: "Incident not found" }, 404);
  }

  // Verify the authenticated user owns this incident
  if (incident.userId !== userEmail) {
    return c.json({ success: false, message: "Forbidden" }, 403);
  }

  // Append logs to R2
  try {
    if (appPackageName) {
      // App telemetry - use dedicated method that organizes by package name
      await incidentStorage.appendAppTelemetry(incidentId, appPackageName, body.logs);
    } else if (logCategory) {
      // Phone or glasses logs
      await incidentStorage.appendLogs(incidentId, logCategory, body.logs, source);
    }

    logger.info(
      {
        incidentId,
        source,
        logCategory: logCategory || "appTelemetry",
        packageName: appPackageName,
        count: body.logs.length,
      },
      "Logs uploaded to incident",
    );

    return c.json({ success: true });
  } catch (err) {
    logger.error({ incidentId, source, err }, "Failed to append logs to incident");
    return c.json({ success: false, message: "Storage error" }, 500);
  }
});

// ============================================================================
// Attachment Upload
// ============================================================================

const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];

/**
 * POST /api/incidents/:incidentId/attachments
 * Upload screenshot attachments to an incident.
 *
 * Auth: Authorization: Bearer <coreToken>
 *
 * Body: multipart/form-data with "files" field(s)
 */
app.post("/:incidentId/attachments", async (c) => {
  const incidentId = c.req.param("incidentId");

  // Auth - coreToken only (phone uploads)
  const authHeader = c.req.header("Authorization");
  const coreToken = authHeader?.replace("Bearer ", "");

  if (!coreToken) {
    return c.json({ success: false, message: "Missing authentication" }, 401);
  }

  let userEmail: string;
  try {
    const decoded = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;
    if (!decoded || !decoded.email) {
      return c.json({ success: false, message: "Invalid token" }, 401);
    }
    userEmail = decoded.email;
  } catch {
    return c.json({ success: false, message: "Invalid token" }, 401);
  }

  // Check if incident exists and verify ownership
  const incident = await Incident.findOne({ incidentId });
  if (!incident) {
    return c.json({ success: false, message: "Incident not found" }, 404);
  }

  if (incident.userId !== userEmail) {
    return c.json({ success: false, message: "Forbidden" }, 403);
  }

  // Check existing attachment count
  let existingLogs;
  try {
    existingLogs = await incidentStorage.getIncidentLogs(incidentId);
  } catch {
    return c.json({ success: false, message: "Failed to read incident" }, 500);
  }

  const existingCount = existingLogs.attachments?.length || 0;
  if (existingCount >= MAX_ATTACHMENTS) {
    return c.json({ success: false, message: `Maximum ${MAX_ATTACHMENTS} attachments allowed` }, 400);
  }

  // Parse multipart form data
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ success: false, message: "Invalid multipart body" }, 400);
  }

  // Get files - can be single file or array
  const filesField = body["files"];
  let files: File[] = [];

  if (filesField instanceof File) {
    files = [filesField];
  } else if (Array.isArray(filesField)) {
    files = filesField.filter((f): f is File => f instanceof File);
  }

  if (files.length === 0) {
    return c.json({ success: false, message: "No files provided" }, 400);
  }

  // Check if adding these would exceed the limit
  if (existingCount + files.length > MAX_ATTACHMENTS) {
    return c.json(
      {
        success: false,
        message: `Can only add ${MAX_ATTACHMENTS - existingCount} more attachment(s)`,
      },
      400,
    );
  }

  // Validate and upload each file
  const uploaded: Array<{ filename: string; storedAs: string }> = [];
  const errors: Array<{ filename: string; error: string }> = [];

  for (const file of files) {
    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      errors.push({
        filename: file.name,
        error: `Invalid file type: ${file.type}. Allowed: PNG, JPEG, WebP`,
      });
      continue;
    }

    // Validate size
    if (file.size > MAX_FILE_SIZE) {
      errors.push({
        filename: file.name,
        error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: 10MB`,
      });
      continue;
    }

    try {
      // Convert to buffer
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (!buffer || buffer.length === 0) {
        errors.push({ filename: file.name, error: "Empty file data" });
        continue;
      }

      // Store to R2
      const metadata = await incidentStorage.storeAttachment(incidentId, file.name, buffer, file.type);

      // Append metadata to incident
      await incidentStorage.appendAttachment(incidentId, metadata);

      uploaded.push({ filename: file.name, storedAs: metadata.storedAs });
    } catch (err) {
      logger.error({ incidentId, filename: file.name, err }, "Failed to upload attachment");
      errors.push({ filename: file.name, error: "Upload failed" });
    }
  }

  logger.info(
    {
      incidentId,
      uploadedCount: uploaded.length,
      errorCount: errors.length,
    },
    "Attachment upload completed",
  );

  return c.json({
    success: uploaded.length > 0,
    uploaded,
    errors: errors.length > 0 ? errors : undefined,
  });
});

export default app;
