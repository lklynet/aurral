import crypto from "crypto";
import { dbOps, userOps } from "../db/helpers/index.js";
import { auth, setAuthUserPassword } from "../services/betterAuth.js";

function parseArgs(argv) {
  const args = {
    username: "",
    password: "",
    generate: false,
    length: 24,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "").trim();
    if (!token) continue;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--generate" || token === "-g") {
      args.generate = true;
      continue;
    }
    if (token === "--username" || token === "-u") {
      args.username = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token.startsWith("--username=")) {
      args.username = token.slice("--username=".length).trim();
      continue;
    }
    if (token === "--password" || token === "-p") {
      args.password = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (token.startsWith("--password=")) {
      args.password = token.slice("--password=".length);
      continue;
    }
    if (token === "--length" || token === "-l") {
      const parsed = parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed)) args.length = parsed;
      i += 1;
      continue;
    }
    if (token.startsWith("--length=")) {
      const parsed = parseInt(token.slice("--length=".length), 10);
      if (Number.isFinite(parsed)) args.length = parsed;
    }
  }
  return args;
}

function printUsage() {
  console.log("Reset/update admin password from terminal");
  console.log("");
  console.log("Usage:");
  console.log(
    '  npm run auth:reset-admin-password -- --password "new-password"',
  );
  console.log(
    "  npm run auth:reset-admin-password -- --username admin --generate",
  );
  console.log("");
  console.log("Flags:");
  console.log(
    "  -u, --username   Admin username (default: configured auth user)",
  );
  console.log("  -p, --password   New password");
  console.log("  -g, --generate   Generate a random password");
  console.log("  -l, --length     Generated password length (default: 24)");
  console.log("  -h, --help       Show this help");
}

function generatePassword(length) {
  const safeLength = Math.min(128, Math.max(12, Number(length) || 24));
  let out = "";
  while (out.length < safeLength) {
    out += crypto.randomBytes(32).toString("base64url");
  }
  return out.slice(0, safeLength);
}

function resolveConfiguredAdminUsername(settings) {
  return (
    settings.integrations?.general?.authUser || process.env.AUTH_USER || "admin"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const currentSettings = dbOps.getSettings();
  const username =
    String(args.username || resolveConfiguredAdminUsername(currentSettings))
      .trim()
      .toLowerCase() || "admin";

  const password =
    args.password || (args.generate ? generatePassword(args.length) : "");
  if (!password) {
    console.error("Missing password. Use --password or --generate.");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  const existing = userOps.getUserByUsername(username);

  let resultUser = null;
  if (existing) {
    await setAuthUserPassword(existing.id, password);
    resultUser = userOps.updateUser(existing.id, { role: "admin" });
  } else {
    const email = username.includes("@") ? username : `${username}@aurral.invalid`;
    const created = await auth.api.createUser({
      body: {
        email,
        name: username,
        password,
        role: "admin",
        data: { username, displayUsername: username },
      },
    });
    resultUser = created?.user || created;
  }

  if (!resultUser) {
    console.error("Failed to update admin password.");
    process.exit(1);
  }

  console.log("Admin password reset successful.");
  console.log(`Email: ${resultUser.email}`);
  if (args.generate) {
    console.log(`Generated password: ${password}`);
  } else {
    console.log("Password updated.");
  }
}

main().catch((error) => {
  console.error(error.message || "Failed to update admin password.");
  process.exit(1);
});
