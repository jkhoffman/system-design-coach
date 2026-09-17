// The local server supports up to thirty minutes of advancing recording transfer.
export const RECORDING_BUDGET_MS = 30 * 60_000;
export const GRADE_BUDGET_MS = 180_000;
export const JOB_CLIENT_TIMEOUT_MS = { grade: GRADE_BUDGET_MS + 15_000, recording: RECORDING_BUDGET_MS + 30_000 };
