import express from "express";

import { APP_NAME, APP_VERSION } from "../config/constants.js";
import { resolveUser } from "../middleware/auth.js";

const SUBSONIC_VERSION = "1.16.1";
const SUBSONIC_NAMESPACE = "http://subsonic.org/restapi";
const router = express.Router();

const getParameter = (req, name) => {
  const value = req.query?.[name];
  return String(Array.isArray(value) ? value[0] || "" : value || "");
};

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(value);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

function decodePassword(value) {
  if (!value.startsWith("enc:")) return value;
  const encoded = value.slice(4);
  if (!/^(?:[a-f\d]{2})+$/i.test(encoded)) return null;
  return Buffer.from(encoded, "hex").toString("utf8");
}

function responseAttributes(status) {
  return {
    status,
    version: SUBSONIC_VERSION,
    type: APP_NAME,
    serverVersion: APP_VERSION,
  };
}

function renderXml({ status, error }) {
  const attributes = Object.entries(responseAttributes(status))
    .map(([key, value]) => `${key}="${escapeXml(value)}"`)
    .join(" ");
  const errorElement = error
    ? `<error code="${error.code}" message="${escapeXml(error.message)}"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="${SUBSONIC_NAMESPACE}" ${attributes}>${errorElement}</subsonic-response>`;
}

function sendResponse(res, format, status = "ok", error = null) {
  const payload = {
    "subsonic-response": {
      ...responseAttributes(status),
      ...(error ? { error } : {}),
    },
  };
  res.type(format === "json" ? "application/json" : "application/xml");
  return res.send(format === "json" ? JSON.stringify(payload) : renderXml({ status, error }));
}

function sendError(res, format, code, message) {
  return sendResponse(res, format, "failed", { code, message });
}

function requestedFormat(req) {
  const format = getParameter(req, "f").toLowerCase() || "xml";
  return format === "xml" || format === "json" ? format : null;
}

function validateRequest(req, format) {
  if (!format) return { format: "xml", error: [0, "Unsupported response format. Use xml or json."] };

  for (const parameter of ["u", "v", "c"]) {
    if (!getParameter(req, parameter)) {
      return { format, error: [10, `Required parameter is missing: ${parameter}`] };
    }
  }

  const password = getParameter(req, "p");
  const token = getParameter(req, "t");
  const salt = getParameter(req, "s");
  if (!password && !(token && salt)) {
    return { format, error: [10, "Required parameter is missing: p or t/s"] };
  }

  const version = parseVersion(getParameter(req, "v"));
  if (!version) {
    return { format, error: [20, "Incompatible Subsonic REST protocol version. Client must upgrade."] };
  }
  if (version.major > 1 || (version.major === 1 && version.minor > 16)) {
    return { format, error: [30, "Incompatible Subsonic REST protocol version. Server must upgrade."] };
  }
  if (version.major < 1) {
    return { format, error: [20, "Incompatible Subsonic REST protocol version. Client must upgrade."] };
  }

  return { format, password, token, salt };
}

function handleSubsonicRequest(req, res) {
  const validation = validateRequest(req, requestedFormat(req));
  if (validation.error) return sendError(res, validation.format, ...validation.error);

  const { format, password, token, salt } = validation;
  if (token && salt && !password) {
    return sendError(res, format, 41, "Token authentication is not supported.");
  }

  const decodedPassword = decodePassword(password);
  const user = decodedPassword == null ? null : resolveUser(getParameter(req, "u"), decodedPassword);
  if (!user) return sendError(res, format, 40, "Wrong username or password");
  req.user = user;

  const method = String(req.params.method || "").replace(/\.view$/i, "").toLowerCase();
  if (method !== "ping") return sendError(res, format, 0, `Unsupported request: ${method}`);
  return sendResponse(res, format);
}

router.all("/:method", handleSubsonicRequest);
router.use((_req, res) => sendError(res, "xml", 0, "Unsupported request"));

export default router;
