import type { JobKind } from "@/jobs/catalog";

/**
 * ما يضعه المرحِّل في بيانات مهمة BullMQ: معرّف الطلب في الصندوق وشركته فقط.
 *
 * contracts/jobs.md section 2: the BullMQ jobId is the job_requests id, so the
 * row stays the source of truth and the queue carries no payload copy.
 */
export interface RelayedJobData {
  jobRequestId: string;
  companyId: string;
}

/** محاولة تشغيل واحدة كما يسلّمها العامل إلى غلاف المهام `runJob`. */
export interface JobAttempt extends RelayedJobData {
  kind: JobKind;
  /** 1-based attempt number from BullMQ (`job.attemptsMade + 1`). */
  attempt: number;
  maxAttempts: number;
}

/** الدالة التي يستدعيها العامل لكل محاولة؛ ترمي الخطأ ليعيد BullMQ المحاولة. */
export type ProcessJob = (attempt: JobAttempt) => Promise<void>;
