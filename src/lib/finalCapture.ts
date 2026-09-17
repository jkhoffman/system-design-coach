import type { FinalPayload } from "./sessionPersistence";
/** Capture required content independently of optional third-party scene objects. */
export function captureFinalPayload(core: FinalPayload, scene: () => unknown): FinalPayload {
  const payload: FinalPayload = JSON.parse(JSON.stringify(core));
  try {
    const elements: unknown = JSON.parse(JSON.stringify(scene()));
    if (Array.isArray(elements)) payload.finalScene = elements;
  } catch { /* Circular or unsupported optional scene data must not lose the interview. */ }
  return payload;
}
