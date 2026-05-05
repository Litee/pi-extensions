/**
 * pi-tui integration for the `/local-issue-watcher browse` slash command
 * (tracker issue #0025).
 *
 * This module is intentionally excluded from test coverage (see
 * `vitest.config.ts` → `**\/infoTui.ts`), mirroring the sibling
 * `pi-claude-code-skills-import/src/tuiPicker.ts` which we model this
 * layer on. The pure row/preview logic that makes `/local-issue-watcher
 * list` behave correctly lives in `infoHandler.ts` and is fully
 * unit-tested; what remains here is glue that only surfaces
 * meaningfully under a live pi session.
 *
 * Layout (post-#0025): a single-pane list that fills the panel height.
 * No always-on preview pane; per-issue detail is shown on demand via
 * Enter and dismissed via Esc.
 *
 * Why a mode-state machine inside ONE `ctx.ui.custom` factory (as
 * opposed to stacking two sequential custom screens or using
 * `showOverlay` for the detail view):
 *
 *   - `ctx.ui.custom` returns `Promise<T>` and only one is active at
 *     a time; calling it a second time from `onSelect` would close
 *     the list before opening the detail and then re-open a fresh
 *     list on dismiss, blowing away the search-as-you-type filter and
 *     the highlighted row. Overlays are possible but layer on their
 *     own positioning/sizing concerns.
 *   - A single factory keeps the `selectList` and `searchInput`
 *     instances alive in closure scope across mode flips. The
 *     issue's "Esc returns to the list with state preserved"
 *     acceptance criterion falls out for free — there is no state
 *     to save/restore, just a flag switching which subtree `render`
 *     and `handleInput` dispatch to.
 *
 * Q-key handling: we do NOT bind a bare `q` quit shortcut. The task
 * brief calls out that `q` conflicts with a valid search-box character
 * and suggests either gating it to the empty-search case or dropping
 * it entirely; we dropped it. `Esc` (via `SelectList.onCancel`) and
 * `Ctrl-C` (the TUI's default cancel path) are both wired and satisfy
 * the deliverable.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

import { formatPreview, type InfoPicker, type InfoRow } from "./infoHandler.js";

/** Slash-command `ctx` shape — the second arg that pi passes to a `registerCommand` handler. */
type CommandCtx = Parameters<
	Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
>[1];

/**
 * Build the production `InfoPicker` used by the registered
 * `/local-issue-watcher browse` slash command. Lazily imports
 * `@mariozechner/pi-tui` + `@mariozechner/pi-coding-agent` so this
 * module stays importable in unit tests that never spin up a TUI.
 *
 * Two-mode rendering:
 *
 *   mode === "list"
 *     Header `Text`     — "local-issue-watcher browse: <N> open, <M> total"
 *     Search `Input`    — search-as-you-type; prefixed with a "search: " label
 *     `SelectList`      — one row per open issue, `label = "<skill> #<id>  <title>"`
 *     Hint line         — `Enter: view details · Esc: close · type to filter`
 *
 *   mode === "detail"
 *     Preview `Text`    — `formatPreview(detailInfo)` for the selected row
 *     Hint line         — `Esc: back to list`
 *
 * Input routing (Container-level `handleInput`):
 *
 *   list:
 *     - Up/Down/PageUp/PageDown/Home/End   → SelectList
 *     - Enter                              → SelectList.onSelect → flip to detail mode
 *     - Esc                                → cancel (done(undefined))
 *     - Anything else (printable chars, backspace, Ctrl-W, Ctrl-U, …)
 *         → Input, then `setFilter(input.getValue())` + `tui.requestRender()`
 *
 *   detail:
 *     - Esc / Left-Arrow                   → flip back to list mode (read-only view)
 *     - Everything else                    → ignored
 *
 *   both modes:
 *     - Ctrl-C                             → cancel (done(undefined))
 *
 * Ctrl-C is matched at the very top of `handleInput` BEFORE the
 * mode-dispatch so it is always an emergency exit — the #0026 hotfix
 * that restores the always-closable contract. All key matching uses
 * `matchesKey(data, keyId)` rather than literal byte comparisons so
 * Kitty-protocol-encoded sequences (the actual #0026 trigger) are
 * honoured alongside the legacy forms.
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

			// ---------------------------------------------------------
			// Header — static summary line (shared by both modes, but
			// only rendered in list mode so the detail view can use the
			// full panel height for the issue body).
			// ---------------------------------------------------------
			const listHeader = [
				theme.fg("accent", theme.bold("local-issue-watcher browse")),
				theme.fg("dim", summary),
				"",
			];

			// ---------------------------------------------------------
			// Empty-state short-circuit
			// ---------------------------------------------------------
			if (rows.length === 0) {
				const emptyContainer = new Container();
				emptyContainer.addChild({
					render: () => listHeader,
					invalidate: () => {},
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tui child shape
				} as any);
				emptyContainer.addChild(
					new Text(theme.fg("dim", "(no open issues)"), 1, 1),
				);
				return {
					render: (w: number) => emptyContainer.render(w),
					invalidate: () => emptyContainer.invalidate(),
					handleInput: (data: string) => {
						// Any of the documented close keys exits. Enter also
						// reads naturally here — there is nothing to drill into.
						// Use matchesKey so Kitty-encoded variants of Esc / Ctrl-C
						// are honoured as well as the legacy byte forms (see #0026).
						if (
							matchesKey(data, "escape") ||
							matchesKey(data, "ctrl+c") ||
							matchesKey(data, "enter")
						) {
							done(undefined);
						}
					},
				};
			}

			// ---------------------------------------------------------
			// Mode-state machine. `mode` flips between "list" and
			// "detail"; `detailInfo` is the row the user hit Enter on
			// and is null-ish in list mode.
			// ---------------------------------------------------------
			let mode: "list" | "detail" = "list";
			let detailInfo: InfoRow["info"] | undefined;

			// ---------------------------------------------------------
			// List subtree — header + search input + hint + SelectList
			// ---------------------------------------------------------
			const listContainer = new Container();

			listContainer.addChild({
				render: () => listHeader,
				invalidate: () => {},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tui child shape
			} as any);

			// Search input with a preceding "search:" label Text.
			const searchInput = new Input();
			listContainer.addChild({
				render: () => [theme.fg("dim", "search:")],
				invalidate: () => {},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tui child shape
			} as any);
			listContainer.addChild(searchInput);

			// List — one row per InfoRow.
			const rowByValue = new Map<string, InfoRow>();
			for (const r of rows) rowByValue.set(r.value, r);

			const items = rows.map((r) => ({ value: r.value, label: r.label }));
			const selectList = new SelectList(
				items,
				Math.min(items.length + 2, 20),
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
			listContainer.addChild(selectList);

			// Status-bar hint at the bottom of the list view. Hardcoded
			// key names — pi-tui / pi-coding-agent do not currently
			// export a `keyHint(...)` helper that resolves the actual
			// bindings for `tui.select.confirm` / `app.cancel`, and the
			// issue explicitly allows hardcoded strings as a fallback.
			const listHint = theme.fg(
				"dim",
				"Enter: view details · Esc: close · type to filter",
			);
			listContainer.addChild({
				render: () => ["", listHint],
				invalidate: () => {},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tui child shape
			} as any);

			// ---------------------------------------------------------
			// Detail subtree — preview text + back hint. The Text
			// component is mutable; we re-populate it from
			// `detailInfo` on every mode flip so the user always sees
			// the latest row content (relevant if the underlying file
			// were to change mid-session, though we do not currently
			// re-scan on Enter).
			// ---------------------------------------------------------
			const detailContainer = new Container();
			const previewText = new Text("", 0, 0);
			detailContainer.addChild(previewText);
			const detailHint = theme.fg("dim", "Esc: back to list");
			detailContainer.addChild({
				render: () => ["", detailHint],
				invalidate: () => {},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tui child shape
			} as any);

			// ---------------------------------------------------------
			// SelectList callbacks
			// ---------------------------------------------------------
			selectList.onCancel = () => done(undefined);
			// Enter → drill into detail view for the highlighted row.
			selectList.onSelect = (item) => {
				const row = rowByValue.get(item.value);
				if (!row) return;
				detailInfo = row.info;
				previewText.setText(formatPreview(detailInfo));
				mode = "detail";
				tui.requestRender();
			};

			// ---------------------------------------------------------
			// Input routing
			// ---------------------------------------------------------
			const isListNavKey = (data: string): boolean => {
				// CSI sequences: arrow keys, Home, End, PageUp, PageDown.
				if (data.startsWith("\u001b[")) return true;
				// Enter (both CR and LF variants).
				if (data === "\r" || data === "\n") return true;
				return false;
			};

			return {
				render: (w: number) =>
					mode === "list"
						? listContainer.render(w)
						: detailContainer.render(w),
				invalidate: () => {
					// Invalidate both subtrees so the next frame after a mode
					// flip starts from a clean slate regardless of which
					// direction we came from.
					listContainer.invalidate();
					detailContainer.invalidate();
				},
				handleInput: (data: string) => {
					// #0026: emergency-exit contract — Ctrl-C must ALWAYS
					// close the widget, regardless of mode. The previous
					// implementation only flipped mode on Ctrl-C in detail
					// view (and relied on literal `\u0003` byte matching),
					// which wedged the TUI when Kitty-encoded Ctrl-C was in
					// play and the user had no other way out. Widget-level
					// close is a safety net; the normal detail-mode path is
					// Esc / Left → back to list.
					if (matchesKey(data, "ctrl+c")) {
						done(undefined);
						return;
					}

					if (mode === "detail") {
						// Esc or Left-Arrow → back to list. `matchesKey`
						// handles both legacy byte forms (`\x1b`, `\x1b[D`)
						// and the Kitty-encoded CSI variants the prior
						// literal-equality checks missed (see #0026).
						if (matchesKey(data, "escape") || matchesKey(data, "left")) {
							mode = "list";
							tui.requestRender();
						}
						// All other input in detail mode is swallowed — the
						// preview is read-only.
						return;
					}

					// mode === "list" — unchanged routing from pre-#0025.
					if (matchesKey(data, "escape")) {
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
					tui.requestRender();
				},
			};
		});
	};
}
