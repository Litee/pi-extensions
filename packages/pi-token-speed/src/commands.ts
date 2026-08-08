import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import type {
  CountStrategy,
  DisplayMode,
  EndTpsBehavior,
  TokenSpeedConfig,
} from "./config-types.js";
import { TokenSpeedEngine } from "./engine.js";
import {
  COUNT_STRATEGY_LABELS,
  DISPLAY_LABELS,
  END_TPS_BEHAVIOR_LABELS,
  TOGGLE_LABELS,
} from "./options.js";
import type { Renderer } from "./renderer.js";
import { settings } from "./settings.js";

/**
 * Handles commands for the token-speed extension.
 */
export class CommandManager {
  constructor(
    private readonly renderer: Renderer,
    private readonly engine: TokenSpeedEngine,
  ) {}

  /**
   * Handles the `/tps` command — opens a SettingsList to configure
   * display mode, token counting strategy, and provider token usage.
   *
   * @param ctx The context used by Pi
   */
  async runTps(ctx: ExtensionCommandContext): Promise<void> {
    const config = settings.getConfig();
    const items = this.buildSettingsItems(config);

    await ctx.ui.custom<void>((_tui, _theme, _kb, done) =>
      this.createSettingsList(
        items,
        (id, newValue) => {
          void this.handleSettingChange(id, newValue, ctx);
        },
        done,
      ),
    );
  }

  /**
   * Handles a settings value change — writes the new value and re-renders.
   *
   * @param id The setting identifier
   * @param newValue The new value to apply
   * @param ctx The context used by Pi
   */
  private async handleSettingChange(
    id: string,
    newValue: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (id === "display") {
      await settings.setConfig({ display: newValue as DisplayMode });
    } else if (id === "useProviderTokens") {
      await settings.setConfig({ useProviderTokens: newValue === "on" });
    } else if (id === "countStrategy") {
      await settings.setConfig({
        countStrategy: newValue as CountStrategy,
      });
    } else if (id === "endTpsBehavior") {
      await settings.setConfig({
        endTpsBehavior: newValue as EndTpsBehavior,
      });
    }

    // Re-render with the latest config
    this.engine.initialize();
    this.renderer.update(ctx);
  }

  /**
   * Creates the SettingsList for the token speed settings menu.
   *
   * @param items The settings items to display
   * @param onChange Callback when a setting value changes
   * @param onClose Callback when the dialog closes
   * @returns The configured SettingsList instance
   */
  private createSettingsList(
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onClose: () => void,
  ): SettingsList {
    return new SettingsList(
      items,
      items.length,
      getSettingsListTheme(),
      onChange,
      onClose,
    );
  }

  /**
   * Builds the SettingsList items for the token speed settings menu.
   *
   * @param config The resolved configuration
   * @returns The array of SettingItem objects
   */
  private buildSettingsItems(config: TokenSpeedConfig): SettingItem[] {
    return [
      {
        id: "display",
        label: "Display mode",
        description: "Level of detail to show in the status bar",
        currentValue: config.display,
        values: Object.keys(DISPLAY_LABELS),
      },
      {
        id: "useProviderTokens",
        label: "Use provider tokens",
        description:
          "Use the provider's token count instead of this extension's counter",
        currentValue: config.useProviderTokens ? "on" : "off",
        values: Object.keys(TOGGLE_LABELS),
      },
      {
        id: "countStrategy",
        label: "Count strategy",
        description:
          "Direct counting (server streams tokens) vs estimate counting (server streams chunks)",
        currentValue: config.countStrategy,
        values: Object.keys(COUNT_STRATEGY_LABELS),
      },
      {
        id: "endTpsBehavior",
        label: "End-of-stream TPS",
        description:
          "What to show after streaming: overall average or last sliding window value",
        currentValue: config.endTpsBehavior,
        values: Object.keys(END_TPS_BEHAVIOR_LABELS),
      },
    ];
  }
}
