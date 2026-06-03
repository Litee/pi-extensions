/**
 * Tool parameters schema for pi-aws-ec2-watcher.
 */

import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool parameters (TypeBox)
// ---------------------------------------------------------------------------

export const MAX_TIMEOUT_SECONDS = 72 * 60 * 60; // 259_200 s

export const Ec2WatcherParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("remove"),
			Type.Literal("list"),
			Type.Literal("status"),
		],
		{
			description:
				"add: start watching an EC2 instance by ID. " +
				"remove: stop watching by watchId. " +
				"list: show all watches. " +
				"status: show runtime state (watch count, poll interval).",
		},
	),
	instanceId: Type.Optional(
		Type.String({
			description:
				"EC2 instance ID in the format i-[0-9a-f]{8,17} (required for 'add').",
		}),
	),
	profile: Type.Optional(
		Type.String({ description: "AWS credentials profile (required for 'add')." }),
	),
	region: Type.Optional(
		Type.String({
			description: "AWS region. Falls back to profile default when omitted.",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"Optional. Cap the watch at this many seconds. Values above 72 h (259200 s) are capped. Defaults to 72 h (259200 s) if omitted.",
		}),
	),
	watchId: Type.Optional(
		Type.String({ description: "Watch ID returned by 'add', required for 'remove'." }),
	),
});
