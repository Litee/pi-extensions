import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SpeakParamsT } from "./schema.js";

type Theme = Parameters<NonNullable<ToolDefinition["renderResult"]>>[2];

export interface SpeakResultDetails {
  ok: boolean;
  voice: string;
  lang: string;
  text: string;
  ms?: number;
  elapsed?: number;
  message?: string;
}

export function renderCall(args: Partial<SpeakParamsT> | undefined, theme: Theme): Text {
  const voice = args?.voice ?? "M1";
  const lang = args?.lang ?? "en";
  const text = args?.text ?? "";
  return new Text(
    `${theme.fg("success", "🔊")} ${theme.bold("speak")} ${theme.fg("dim", `[${voice}/${lang}]`)}\n` +
    `${theme.fg("text", text)}`,
    0, 0,
  );
}

export const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, { isPartial }, theme) => {
  const d = (result as { details?: SpeakResultDetails }).details;

  // Before first onUpdate — show a minimal placeholder
  if (!d) return new Text(theme.fg("muted", "🔊 …"), 0, 0);

  if (!d.ok) {
    return new Text(theme.fg("error", `✗ ${d.message ?? "failed"}`), 0, 0);
  }

  if (isPartial) {
    const elapsed = d.elapsed ?? 0;
    return new Text(
      `${theme.fg("accent", "⏱")} ${theme.fg("accent", `${elapsed}s`)}`,
      0, 0,
    );
  }

  // Final
  const time = d.ms !== undefined ? `${(d.ms / 1000).toFixed(1)}s` : "done";
  return new Text(theme.fg("success", `✓ ${time}`), 0, 0);
};
