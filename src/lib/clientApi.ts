export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(typeof body?.error === "string" ? body.error : `Request failed (${response.status})`, response.status);
  if (body === null) throw new Error("The server returned an invalid response");
  return body as T;
}
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return parseJsonResponse<T>(await fetch(url, init));
}
