import "server-only";
import { validSessionId } from "./schemas";

/** Route-specific readers keep control over which fields are loaded. */
export function findSession<T>(id: string, read: (id: string) => T | null): T | null {
  return validSessionId(id) ? read(id) : null;
}
