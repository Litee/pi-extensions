import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface HeadroomConfig {
	enabled: boolean;
	baseUrl: string;
	allowRemote: boolean;
	command: string;
	minContextTokens: number;
	minMessageChars: number;
	timeoutMs: number;
}

export interface HeadroomStats {
	attempts: number;
	applied: number;
	tokensSaved: number;
	last?: {
		tokensBefore: number;
		tokensAfter: number;
		tokensSaved: number;
		compressionRatio: number;
	};
}

export interface HeadroomRuntimeState {
	enabled: boolean;
	proxyOnline: boolean | null;
	remoteWarningShown: boolean;
	offlineWarningShown: boolean;
	stats: HeadroomStats;
}

export interface HeadroomRuntime {
	config: HeadroomConfig;
	state: HeadroomRuntimeState;
	refreshStatus(ctx: ExtensionContext): void;
}
