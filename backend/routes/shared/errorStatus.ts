import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status";
import type { AppError } from "../../../lib/errors.ts";

export const isErrorStatus = (
  status: number | undefined,
): status is ClientErrorStatusCode | ServerErrorStatusCode =>
  Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599;

export const errorStatus = (error: AppError | undefined) =>
  isErrorStatus(error?.statusCode) ? error.statusCode : 500;
