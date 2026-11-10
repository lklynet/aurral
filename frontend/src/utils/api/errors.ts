import { asApiError } from "./core.ts";

export const getApiErrorBody = (error: unknown) => {
  const data = asApiError(error)?.response?.data;
  return typeof data === "object" && data ? data : undefined;
};

export const getApiErrorText = (error: unknown, key: "message" | "error") => {
  const value = getApiErrorBody(error)?.[key];
  return typeof value === "string" ? value : undefined;
};

export const getApiErrorMessage = (error: unknown, fallback: string) =>
  getApiErrorText(error, "message") ||
  getApiErrorText(error, "error") ||
  asApiError(error)?.message ||
  fallback;

export function readApiError(error: unknown) {
  return {
    status: asApiError(error)?.response?.status,
    body: getApiErrorBody(error),
    message: getApiErrorText(error, "message"),
    error: getApiErrorText(error, "error"),
    text: asApiError(error)?.message,
  };
}
