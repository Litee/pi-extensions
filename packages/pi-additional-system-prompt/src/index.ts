import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDELINES = readFileSync(join(__dirname, "../assets/PROMPT.md"), "utf-8");

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt: event.systemPrompt + "\n" + GUIDELINES,
    };
  });
}
