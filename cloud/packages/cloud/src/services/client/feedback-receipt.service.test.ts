import { describe, expect, test } from "bun:test";

import {
  getFeedbackReceiptType,
  queueFeedbackReceipt,
  resolveFeedbackReceiptRecipient,
  shouldSendFeedbackReceipt,
  type FeedbackReceiptSender,
} from "./feedback-receipt.service";

describe("feedback receipt helpers", () => {
  test("uses contactEmail when provided and valid", () => {
    expect(
      resolveFeedbackReceiptRecipient("relay@example.com", {
        type: "bug",
        contactEmail: "  followup@example.com  ",
      }),
    ).toBe("followup@example.com");
  });

  test("falls back to auth email when contactEmail is invalid", () => {
    expect(
      resolveFeedbackReceiptRecipient("user@example.com", {
        type: "feature",
        contactEmail: "not-an-email",
      }),
    ).toBe("user@example.com");
  });

  test("classifies structured and legacy feedback", () => {
    expect(getFeedbackReceiptType({ type: "bug" })).toBe("bug");
    expect(getFeedbackReceiptType({ type: "feature" })).toBe("feature");
    expect(getFeedbackReceiptType("legacy feedback")).toBe("feedback");
  });

  test("skips automatic bug report receipts", () => {
    expect(
      shouldSendFeedbackReceipt({
        type: "bug",
        submissionMode: "AUTOMATIC",
      }),
    ).toBe(false);
  });

  test("queues receipts without awaiting delivery", () => {
    let calls = 0;
    const sender: FeedbackReceiptSender = {
      sendFeedbackReceipt: () => {
        calls += 1;
        return new Promise(() => {});
      },
    };

    queueFeedbackReceipt("user@example.com", { type: "feature" }, { sender });

    expect(calls).toBe(1);
  });

  test("does not call sender for automatic bug reports", () => {
    let calls = 0;
    const sender: FeedbackReceiptSender = {
      sendFeedbackReceipt: async () => {
        calls += 1;
        return {};
      },
    };

    queueFeedbackReceipt(
      "user@example.com",
      {
        type: "bug",
        submissionMode: "AUTOMATIC",
      },
      { sender },
    );

    expect(calls).toBe(0);
  });
});
