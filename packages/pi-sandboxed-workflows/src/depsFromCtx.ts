/**
 * Translate a pi `ExtensionContext` into the slim {@link RunWorkflowDeps}
 * shape the runtime expects. Extracted so unit tests can verify the
 * mapping without standing up a live `ExtensionAPI`.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { UiForHost } from "./host.js";
import type { RunWorkflowDeps } from "./runtime.js";

export function depsFromCtx(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	sessionSignal: AbortSignal,
): RunWorkflowDeps {
	const { ui, hasUI } = ctx;
	const notify = ui.notify.bind(ui);
	const setStatus = ui.setStatus.bind(ui);

	const uiForHost: UiForHost = {
		hasUI,
		input: (prompt, defaultValue) => ui.input(prompt, defaultValue),
		select: (prompt, options) => ui.select(prompt, [...options]),
		confirm: (title, body) => ui.confirm(title, body),
	};

	return {
		sendMessage: (message, opts) => pi.sendMessage(message, opts),
		notify: (m, l) => notify(m, l),
		setStatus: (k, c) => setStatus(k, c),
		clearStatus: (k) => setStatus(k, undefined),
		cwd: ctx.cwd,
		signal: sessionSignal,
		ui: uiForHost,
		...(hasUI ? {
			setWidget: (
				key: string,
				factory: Parameters<RunWorkflowDeps["setWidget"] & object>[1],
			) => {
				if (factory === undefined) {
					ui.setWidget(key, undefined);
					return;
				}
				ui.setWidget(key, (tui, theme) => {
					const widgetTheme = {
						fg: (c: string, t: string) =>
							(theme as unknown as { fg(c: string, t: string): string }).fg(c, t),
						dim: (t: string) =>
							(theme as unknown as { fg(c: string, t: string): string }).fg("dim", t),
						bold: (t: string) => theme.bold(t),
					};
					return factory(tui, widgetTheme);
				});
			},
		} : {}),
	};
}
