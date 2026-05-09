// services/client/feedback-receipt.service.ts
// Queues user-facing receipts for submitted feedback and bug reports.

import type { FeedbackData, FeedbackReceiptType } from "../../types/feedback.types";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "feedback-receipt.service" });

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface FeedbackReceiptSender {
  sendFeedbackReceipt(
    recipientEmail: string,
    feedbackType: FeedbackReceiptType,
    incidentId?: string,
  ): Promise<{ id?: string; error?: unknown }>;
}

interface FeedbackReceiptLogger {
  warn: (metadata: Record<string, unknown>, message: string) => void;
}

export interface QueueFeedbackReceiptOptions {
  incidentId?: string;
  logger?: FeedbackReceiptLogger;
  sender?: FeedbackReceiptSender;
}

function isStructuredFeedback(feedback: string | FeedbackData): feedback is FeedbackData {
  return typeof feedback === "object" && feedback !== null;
}

function normalizeEmail(email: unknown): string | undefined {
  if (typeof email !== "string") {
    return undefined;
  }

  const trimmed = email.trim();
  return EMAIL_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function resolveFeedbackReceiptRecipient(authEmail: string, feedback: string | FeedbackData): string {
  if (isStructuredFeedback(feedback)) {
    return normalizeEmail(feedback.contactEmail) || authEmail;
  }

  return authEmail;
}

export function getFeedbackReceiptType(feedback: string | FeedbackData): FeedbackReceiptType {
  if (isStructuredFeedback(feedback)) {
    return feedback.type;
  }

  return "feedback";
}

export function shouldSendFeedbackReceipt(feedback: string | FeedbackData): boolean {
  return !(isStructuredFeedback(feedback) && feedback.type === "bug" && feedback.submissionMode === "AUTOMATIC");
}

async function getDefaultSender(): Promise<FeedbackReceiptSender> {
  const { emailService } = await import("../email/resend.service");
  return emailService;
}

export function queueFeedbackReceipt(
  authEmail: string,
  feedback: string | FeedbackData,
  options: QueueFeedbackReceiptOptions = {},
): void {
  if (!shouldSendFeedbackReceipt(feedback)) {
    return;
  }

  const receiptLogger = options.logger || logger;
  const recipientEmail = resolveFeedbackReceiptRecipient(authEmail, feedback);
  const feedbackType = getFeedbackReceiptType(feedback);

  const sendReceipt = async () => {
    const sender = options.sender || (await getDefaultSender());
    const result = await sender.sendFeedbackReceipt(recipientEmail, feedbackType, options.incidentId);

    if (result.error) {
      receiptLogger.warn(
        {
          error: result.error,
          feedbackType,
          incidentId: options.incidentId,
          recipientEmail,
        },
        "Feedback receipt email returned an error",
      );
    }
  };

  sendReceipt().catch((error) => {
    receiptLogger.warn(
      {
        error,
        feedbackType,
        incidentId: options.incidentId,
        recipientEmail,
      },
      "Feedback receipt email failed",
    );
  });
}
