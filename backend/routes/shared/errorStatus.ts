import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status";
import { asAppError, type AppError } from "../../../lib/errors.ts";

export const isErrorStatus = (
  status: number | undefined,
): status is ClientErrorStatusCode | ServerErrorStatusCode =>
  Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599;

export const errorStatus = (error: AppError | undefined) =>
  isErrorStatus(error?.statusCode) ? error.statusCode : 500;

export const getErrorStatus = (error: unknown) => {
  const failure = asAppError(error);
  const status = failure?.statusCode || failure?.response?.status;
  return isErrorStatus(status) ? status : 500;
};

export const isFailure = <T extends { error?: unknown } | null | undefined>(
  result: T,
): result is Extract<T, { error: string | undefined }> => Boolean(result?.error);
