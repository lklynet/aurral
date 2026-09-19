process.send({ type: "ready" });

process.on("message", (message) => {
  if (message?.type === "block") {
    const until = Date.now() + 400;
    while (Date.now() < until) {} // Deliberately occupy only the child event loop.
    process.send({ type: "done" });
  } else if (message?.type === "shutdown") {
    process.exit(0);
  }
});
