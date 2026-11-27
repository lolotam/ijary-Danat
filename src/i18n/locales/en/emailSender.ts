/**
 * English translation keys for the email sender status (User Story 10).
 */
export const emailSender: Record<string, string> = {
  "emailSender.title": "Email sender",
  "emailSender.mode": "Sender",
  "emailSender.own": "The company's own sender",
  "emailSender.platform": "The platform's default sender",
  "emailSender.none": "No sender is configured",
  "emailSender.from": "Sending address",
  "emailSender.replyTo": "Replies go to",
  "emailSender.hint":
    "A company that configures no sender of its own sends through the platform's sender, with its name shown on the message and its address receiving the replies.",
  "emailSender.loadError": "Could not read the email sender status.",
};
