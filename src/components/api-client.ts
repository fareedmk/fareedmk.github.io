export async function request<T>(path: string, data?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok) {
    throw new ApiError(body.error?.message ?? body.message ?? body.error?.code ?? `Request failed (${response.status})`, response.status, body.error?.code ?? "UNKNOWN");
  }
  return body as T;
}

export const money = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount / 100);
export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}
