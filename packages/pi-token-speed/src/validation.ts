import type {
  CountStrategy,
  DisplayMode,
  EndTpsBehavior,
  TokenSpeedConfig,
} from "./config-types.js";
import { MAX_SLIDING_WINDOW, MIN_SLIDING_WINDOW } from "./constants.js";
import {
  COLOR_BLAZING,
  COLOR_FAST,
  COLOR_MEDIUM,
  COLOR_SLOW,
  COUNT_STRATEGY,
  DISPLAY_MODE,
  END_TPS_BEHAVIOR,
  SLIDING_WINDOW,
  TPS_THRESHOLD_BLAZING,
  TPS_THRESHOLD_FAST,
  TPS_THRESHOLD_MEDIUM,
  TPS_THRESHOLD_SLOW,
  USE_PROVIDER_TOKENS,
} from "./defaults.js";
import {
  COUNT_STRATEGY_LABELS,
  DISPLAY_LABELS,
  END_TPS_BEHAVIOR_LABELS,
} from "./options.js";

/**
 * Static utility class for TokenSpeed configuration validation.
 */
export class Validator {
  /**
   * Validates the config, correcting invalid values and collecting errors.
   *
   * @param config The configuration to validate
   * @returns The corrected configuration and a list of error messages
   */
  static validate(config: TokenSpeedConfig): {
    config: TokenSpeedConfig;
    errors: string[];
  } {
    const response = { ...config };
    const errors: string[] = [];

    // Correct values with defaults where applicable
    response.display = this.checkDisplayMode(config.display, errors);
    response.countStrategy = this.checkCountStrategy(
      config.countStrategy,
      errors,
    );
    response.useProviderTokens = this.checkUseProviderTokens(
      config.useProviderTokens,
      errors,
    );
    response.slidingWindow = this.checkSlidingWindow(
      config.slidingWindow,
      errors,
    );
    response.endTpsBehavior = this.checkEndTpsBehavior(
      config.endTpsBehavior,
      errors,
    );

    // Error-only checks (no correction)
    const thresholdResult = this.isValidThresholdOrder(config);
    if (!thresholdResult.valid) {
      errors.push(...thresholdResult.errors ?? []);
    }

    const colorResult = this.isValidColorDefinition(config);
    if (!colorResult.valid) {
      errors.push(
        "- Colors must be valid 24-bit truecolor ANSI hex strings (e.g., '#00ff88').",
      );
      errors.push(
        `  Found: ${config.colorSlow} | ${config.colorMedium} | ${config.colorFast} | ${config.colorBlazing}.`,
      );
      errors.push(...colorResult.errors ?? []);
    }

    return { config: response, errors };
  }

  /**
   * Validates that the string is a valid 24-bit truecolor ANSI hex string.
   *
   * @param s The string to validate
   * @returns True if the string is a valid hex color; false otherwise
   */
  static isValidHex(s: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(s);
  }

  /**
   * Validates that TPS thresholds are in strict ascending order:
   * tpsSlow < tpsMedium < tpsFast < tpsBlazing.
   *
   * @param config The configuration to validate
   * @returns An object with validity status and optional error messages
   */
  private static isValidThresholdOrder(config: TokenSpeedConfig): {
    valid: boolean;
    errors?: string[];
  } {
    const {
      tpsSlow = TPS_THRESHOLD_SLOW,
      tpsMedium = TPS_THRESHOLD_MEDIUM,
      tpsFast = TPS_THRESHOLD_FAST,
      tpsBlazing = TPS_THRESHOLD_BLAZING,
    } = config;
    const valid =
      tpsSlow < tpsMedium && tpsMedium < tpsFast && tpsFast < tpsBlazing;
    return {
      valid,
      ...(valid
        ? {}
        : {
            errors: [
              "- TPS thresholds must be in ascending order.",
              `  Found: ${tpsSlow} < ${tpsMedium} < ${tpsFast} < ${tpsBlazing}.`,
            ],
          }),
    };
  }

  /**
   * Validates that color definitions are valid 24-bit truecolor ANSI hex strings.
   *
   * @param config The configuration to validate
   * @returns An object with validity status and optional error messages
   */
  private static isValidColorDefinition(config: TokenSpeedConfig): {
    valid: boolean;
    errors?: string[];
  } {
    const {
      colorSlow = COLOR_SLOW,
      colorMedium = COLOR_MEDIUM,
      colorFast = COLOR_FAST,
      colorBlazing = COLOR_BLAZING,
    } = config;
    const errors: string[] = [];
    if (!Validator.isValidHex(colorSlow))
      errors.push(`  - Invalid colorSlow: ${colorSlow}`);
    if (!Validator.isValidHex(colorMedium))
      errors.push(`  - Invalid colorMedium: ${colorMedium}`);
    if (!Validator.isValidHex(colorFast))
      errors.push(`  - Invalid colorFast: ${colorFast}`);
    if (!Validator.isValidHex(colorBlazing))
      errors.push(`  - Invalid colorBlazing: ${colorBlazing}`);
    return { valid: errors.length === 0, errors };
  }

  /**
   * Checks that display mode is a recognized value, defaulting if invalid.
   *
   * @param value The display mode value to check.
   * @param errors The shared errors array to push to if invalid.
   * @returns The validated (or defaulted) display mode.
   */
  private static checkDisplayMode(
    value: string,
    errors: string[],
  ): DisplayMode {
    if (Object.keys(DISPLAY_LABELS).includes(value))
      return value as DisplayMode;

    errors.push(
      `- Invalid display "${value}" — defaulting to "${DISPLAY_MODE}".`,
    );

    return DISPLAY_MODE;
  }

  /**
   * Checks that countStrategy is a recognized value, defaulting if invalid.
   *
   * @param value The count strategy value to check.
   * @param errors The shared errors array to push to if invalid.
   * @returns The validated (or defaulted) count strategy.
   */
  private static checkCountStrategy(
    value: string,
    errors: string[],
  ): CountStrategy {
    if (Object.keys(COUNT_STRATEGY_LABELS).includes(value))
      return value as CountStrategy;

    errors.push(
      `- Invalid countStrategy "${value}" — defaulting to "${COUNT_STRATEGY}".`,
    );

    return COUNT_STRATEGY;
  }

  /**
   * Checks that useProviderTokens is a boolean, defaulting if invalid.
   *
   * @param value The useProviderTokens value to check.
   * @param errors The shared errors array to push to if invalid.
   * @returns The validated (or defaulted) boolean value.
   */
  private static checkUseProviderTokens(
    value: unknown,
    errors: string[],
  ): boolean {
    if (typeof value === "boolean") return value;

    errors.push(
      `- Invalid useProviderTokens (expected boolean) — defaulting to ${USE_PROVIDER_TOKENS}.`,
    );

    return USE_PROVIDER_TOKENS;
  }

  /**
   * Checks that sliding window is a reasonable number (between 100ms and 30s),
   * defaulting if invalid.
   *
   * @param value The sliding window value to check.
   * @param errors The shared errors array to push to if invalid.
   * @returns The validated (or defaulted) sliding window value.
   */
  private static stringifyValue(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  /**
   * Checks that slidingWindow is a valid number within bounds, defaulting if invalid.
   *
   * @param value The slidingWindow value to check.
   * @param errors The shared errors array to push to if invalid.
   * @returns The validated (or defaulted) sliding window duration.
   */
  private static checkSlidingWindow(value: unknown, errors: string[]): number {
    if (
      typeof value === "number" &&
      value >= MIN_SLIDING_WINDOW &&
      value <= MAX_SLIDING_WINDOW
    )
      return value;

    errors.push(
      `- Invalid slidingWindow "${this.stringifyValue(value)}" — defaulting to ${SLIDING_WINDOW}.`,
    );

    return SLIDING_WINDOW;
  }

  /**
   * Checks that endTpsBehavior is a recognized value, defaulting if invalid.
   *
   * @param value The endTpsBehavior value to check.
   * @param errors The shared errors array to push to if invalid.
   * @returns The validated (or defaulted) end TPS behavior.
   */
  private static checkEndTpsBehavior(
    value: unknown,
    errors: string[],
  ): EndTpsBehavior {
    if (Object.keys(END_TPS_BEHAVIOR_LABELS).includes(value as string))
      return value as EndTpsBehavior;

    errors.push(
      `- Invalid endTpsBehavior "${this.stringifyValue(value)}" — defaulting to "${END_TPS_BEHAVIOR}".`,
    );

    return END_TPS_BEHAVIOR;
  }
}
