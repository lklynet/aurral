import { asApiError } from "../../../utils/api/core.ts";

export function readApiError(error: unknown) {
  const failure = asApiError(error);
  const data = failure?.response?.data;
  const body = typeof data === "object" && data ? data : undefined;
  return {
    status: failure?.response?.status,
    body,
    message: body?.message,
    error: typeof body?.error === "string" ? body.error : undefined,
    text: failure?.message,
  };
}
