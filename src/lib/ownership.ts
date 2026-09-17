export interface SessionOwner { ownerToken: string; generation: number }
// Background timer throttling or one failed checkpoint must not enable takeover.
export const OWNER_LEASE_MS = 180_000;
export const HEARTBEAT_MS = 20_000;
