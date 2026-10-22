import { asApiError } from "../../../utils/api/core.ts";
import { getApiErrorBody, getApiErrorText } from "../../onboardingUtils.tsx";

export function readApiError(error: unknown) {
  return {
    status: asApiError(error)?.response?.status,
    body: getApiErrorBody(error),
    message: getApiErrorText(error, "message"),
    error: getApiErrorText(error, "error"),
    text: asApiError(error)?.message,
  };
}
