export interface ErrorResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  data?: unknown;
}

export interface AppError extends Error {
  code?: string;
  statusCode?: number;
  status?: number;
  response?: ErrorResponse;
}

export function asAppError(error: unknown): AppError | undefined {
  return error instanceof Error ? error : undefined;
}

export function errorResponseText(
  error: AppError | undefined,
  key: "message" | "error",
): string | undefined {
  const data = error?.response?.data;
  if (typeof data !== "object" || data === null) return undefined;
  const value: unknown = Reflect.get(data, key);
  return typeof value === "string" ? value : undefined;
}
