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
  if (!r.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}
