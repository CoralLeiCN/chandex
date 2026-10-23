export async function api(
  path: string,
  method = "GET",
  body?: unknown,
  options?: Pick<RequestInit, "signal" | "keepalive">,
) {
  const r = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    ...options,
  });
  const data = await r.json();
  if (!r.ok) throw new ApiError(data.error ?? "Request failed.", r.status);
  return data;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
