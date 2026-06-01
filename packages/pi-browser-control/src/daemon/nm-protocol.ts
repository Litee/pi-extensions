/**
 * Type guards for the native-messaging host↔addon protocol.
 *
 * host → addon (HostRequest):
 *   { correlationId, op:"listTabs" }
 *   { correlationId, op:"getTabContent", params:{tabId,offset} }
 *   { correlationId, op:"ping" }
 *
 * addon → host (AddonReply):
 *   { correlationId, ok:true, result:... }
 *   { correlationId, ok:false, error:{code,message} }
 */

export type HostRequestOp = "listTabs" | "getTabContent" | "ping";

export interface GetTabContentParams {
	tabId: number;
	offset: number;
}

export interface HostRequest {
	correlationId: string;
	op: HostRequestOp;
	params?: GetTabContentParams;
}

export interface AddonErrorInfo {
	code: string;
	message: string;
}

export interface AddonReply {
	correlationId: string;
	ok: boolean;
	result?: unknown;
	error?: AddonErrorInfo;
}

export function isHostRequest(v: unknown): v is HostRequest {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o["correlationId"] === "string" &&
		(o["op"] === "listTabs" ||
			o["op"] === "getTabContent" ||
			o["op"] === "ping")
	);
}

export function isAddonReply(v: unknown): v is AddonReply {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return typeof o["correlationId"] === "string" && typeof o["ok"] === "boolean";
}
