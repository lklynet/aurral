import net from "node:net";

const [host, port] = String(process.argv[2] || "").split(":");

const server = net.createServer((client) => {
  const upstream = net.connect(Number(port), host);
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});

server.listen(3001);
process.on("SIGTERM", () => process.exit(0));
