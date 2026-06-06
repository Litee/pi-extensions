import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDELINES = readFileSync(join(__dirname, "../assets/PROMPT.md"), "utf-8");
const SENTINEL = "<!-- pi-additional-system-prompt -->";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, _ctx) => {
    if (event.systemPrompt.includes(SENTINEL)) {
      return { systemPrompt: event.systemPrompt };
    }
    return {
      systemPrompt: event.systemPrompt + "\n" + SENTINEL + "\n" + GUIDELINES,
    };
  });
}
