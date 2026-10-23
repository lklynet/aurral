import { existsSync, writeFileSync } from "node:fs";

process.send?.({ type: "ready" });

type ParentMessage =
  | { type: "block"; blockingPath: string; releasePath: string }
  | { type: "shutdown" };

process.on("message", (message: ParentMessage) => {
  if (message.type === "block") {
    writeFileSync(message.blockingPath, "");
    const deadline = Date.now() + 10_000;
    while (!existsSync(message.releasePath) && Date.now() < deadline) {}
    process.send?.({ type: "done", released: existsSync(message.releasePath) });
  } else if (message.type === "shutdown") {
    process.exit(0);
  }
});
