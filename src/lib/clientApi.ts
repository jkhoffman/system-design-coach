export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `Request failed (${response.status})`);
  if (body === null) throw new Error("The server returned an invalid response");
  return body as T;
}
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return parseJsonResponse<T>(await fetch(url, init));
}
