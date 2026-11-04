import guide from "../../../backend/services/plugins/plugin-api.md?raw";
import types from "../../../backend/services/plugins/aurral-plugin.d.ts?raw";

export const GET = () =>
  new Response(`# Aurral plugin API 1\n\n${guide}\n## Types\n\n\`\`\`ts\n${types}\`\`\`\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
