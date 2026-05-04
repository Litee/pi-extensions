/**
 * pi-tui integration for the `/local-issue-watcher-info` slash command
 * (tracker issue #0023).
 *
 * This module is intentionally excluded from test coverage (see
 * `vitest.config.ts` → `**\/infoTui.ts`), mirroring the sibling
 * `pi-claude-code-skills-import/src/tuiPicker.ts` which we model this
 * layer on. The pure row/preview logic that makes `/local-issue-watcher-info`
 * behave correctly lives in `infoHandler.ts` and is fully unit-tested;
 * what remains here is glue that only surfaces meaningfully under a live
 * pi session.
 *
 * Why a dual-pane layout instead of embedding the preview in each list
 * row: `SettingsList` supports a per-item `description` but spends most
 * of its screen width on the list column. `SelectList.onSelectionChange`
 * lets us maintain a separate, full-width `Text` component for the
 * selected issue's description + comments, which is the whole point of
 * the issue — the user wants to skim bodies, not just titles.
 *
 * Q-key handling: we do NOT bind a bare `q` quit shortcut. The task
 * brief calls out that `q` conflicts with a valid search-box character
 * and suggests either gating it to the empty-search case or dropping
 * it entirely; we dropped it. `Esc` (via `SelectList.onCancel`) and
 * `Ctrl-C` (the TUI's default cancel path) are both wired and satisfy
 * the deliverable.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { formatPreview, type InfoPicker, type InfoRow } from "./infoHandler.js";

/** Slash-command `ctx` shape — the second arg that pi passes to a `registerCommand` handler. */
type CommandCtx = Parameters<
	Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
>[1];

/**
 * Build the production `InfoPicker` used by the registered
 * `/local-issue-watcher-info` slash command. Lazily imports
 * `@mariozechner/pi-tui` + `@mariozechner/pi-coding-agent` so this
 * module stays importable in unit tests that never spin up a TUI.
 *
 * Implementation shape:
 *   - Header `Text`       — "local-issue-watcher-info: <N> open, <M> total"
 *   - Search `Input`      — search-as-you-type; prefixed with a "search: " label Text
 *   - `SelectList`        — one row per open issue, `label = "<skill> #<id>  <title>"`
 *   - Preview `Text`      — mutable; re-populated from `formatPreview(row.info)`
 *                           on every `onSelectionChange` event
 *
 * Input routing (Container-level `handleInput`):
 *   - Up/Down/PageUp/PageDown/Home/End/Enter → SelectList
 *   - Esc / Ctrl-C                           → cancel (done(undefined))
 *   - Anything else (printable chars, backspace, Ctrl-W, Ctrl-U, …)
 *       → Input, then `setFilter(input.getValue())` + `tui.requestRender()`
 */
export function makeInfoTuiPicker(ctx: CommandCtx): InfoPicker {
	return async ({ rows, summary }) => {
		const [{ getSelectListTheme }, { Container, Input, SelectList, Text }] =
			await Promise.all([
				import("@mariozechner/pi-coding-agent"),
				import("@mariozechner/pi-tui"),
			]);

		await ctx.ui.custom((tui, _theme, _kb, done) => {
			const theme = ctx.ui.theme;
			const selectListTheme = getSelectListTheme();

			const container = new Container();

			// ---------------------------------------------------------
			// Header — static summary line
			// ---------------------------------------------------------
			const headerLines = [
				theme.fg("accent", theme.bold("local-issue-watcher-info")),
				theme.fg("dim", summary),
				theme.fg(
					"dim",
					"↑/↓ select · type to filter (skill / id / title) · Esc to exit",
				),
				"",
			];
			container.addChild({
				render: () => headerLines,
				invalidate: () => {},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tui child shape
			} as any);

			// ---------------------------------------------------------
			// Empty-state short-circuit
			// ---------------------------------------------------------
			if (rows.length === 0) {
				container.addChild(
					new Text(theme.fg("dim", "(no open issues)"), 1, 1),
				);
				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						// Any input closes the empty-state panel; Esc/Ctrl-C are
						// the documented shortcuts but Enter also reads naturally.
						if (
							data === "\u001b" ||
							data === "\u0003" ||
							data === "\r" ||
							data === "\n"
						) {
							done(undefined);
						}
					},
				};
			}

			// ---------------------------------------------------------
			// Search input — single-line, label rendered in a preceding Text
			// ---------------------------------------------------------
			const searchInput = new Input();
			container.addChild({
				render: () => [theme.fg("dim", "search:")],
				invalidate: () => {},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tui child shape
			} as any);
			container.addChild(searchInput);

			// ---------------------------------------------------------
			// List — one row per InfoRow
			// ---------------------------------------------------------
			const rowByValue = new Map<string, InfoRow>();
			for (const r of rows) rowByValue.set(r.value, r);

			const items = rows.map((r) => ({ value: r.value, label: r.label }));
			const selectList = new SelectList(
				items,
				Math.min(items.length + 2, 15),
				selectListTheme,
			);
			// Override SelectList.setFilter: the stock implementation matches
			// `value.toLowerCase().startsWith(filter)` which is wrong for us
			// (value is the absolute file path, not the user-visible text).
			// We want a case-insensitive SUBSTRING match over the label
			// (which contains skill + id + title). Runtime patching via
			// `any`-cast because `filteredItems` / `selectedIndex` are
			// marked private in the upstream type but are real runtime
			// fields that SelectList.render() reads on every frame.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional runtime override, see comment above
			const slInternal = selectList as any;
			slInternal.setFilter = (filter: string) => {
				const needle = filter.toLowerCase();
				slInternal.filteredItems = items.filter((it) =>
					it.label.toLowerCase().includes(needle),
				);
				slInternal.selectedIndex = 0;
			};
			container.addChild(selectList);

			// ---------------------------------------------------------
			// Preview pane — mutable Text re-populated on selection change
			// ---------------------------------------------------------
			const previewSeparator = "";
			const previewHeader = theme.fg("dim", "─ preview ─");
			const previewText = new Text("", 0, 0);
			const initial = rows[0];
			if (initial) previewText.setText(formatPreview(initial.info));
			container.addChild({
				render: () => [previewSeparator, previewHeader],
				invalidate: () => {},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tui child shape
			} as any);
			container.addChild(previewText);

			// ---------------------------------------------------------
			// SelectList callbacks
			// ---------------------------------------------------------
			selectList.onCancel = () => done(undefined);
			// Enter is intentionally a no-op: the preview is always visible
			// and the user can keep browsing. Closing is via Esc/Ctrl-C.
			selectList.onSelect = () => {};
			selectList.onSelectionChange = (item) => {
				const row = rowByValue.get(item.value);
				previewText.setText(row ? formatPreview(row.info) : "");
				tui.requestRender();
			};

			// ---------------------------------------------------------
			// Input routing — forward list-navigation keys to SelectList
			// and everything else (printable chars + editing keys) to
			// Input, then re-apply the filter.
			// ---------------------------------------------------------
			const isListNavKey = (data: string): boolean => {
				// CSI sequences: arrow keys, Home, End, PageUp, PageDown.
				if (data.startsWith("\u001b[")) return true;
				// Enter (both CR and LF variants).
				if (data === "\r" || data === "\n") return true;
				return false;
			};

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					// Bare Esc → cancel. CSI sequences start with "\u001b[" and
					// are handled as nav keys below.
					if (data === "\u001b") {
						done(undefined);
						return;
					}
					// Ctrl-C → cancel (the TUI host usually intercepts this, but
					// we handle it defensively so the slash command always exits
					// cleanly).
					if (data === "\u0003") {
						done(undefined);
						return;
					}
					if (isListNavKey(data)) {
						selectList.handleInput(data);
						tui.requestRender();
						return;
					}
					// Everything else — typed chars, backspace, Ctrl-W, Ctrl-U,
					// paste bursts — goes to the search box, then re-filter.
					searchInput.handleInput(data);
					selectList.setFilter(searchInput.getValue());
					const selected = selectList.getSelectedItem();
					if (selected) {
						const row = rowByValue.get(selected.value);
						previewText.setText(row ? formatPreview(row.info) : "");
					} else {
						previewText.setText(theme.fg("dim", "(no matches)"));
					}
					tui.requestRender();
				},
			};
		});
	};
}
