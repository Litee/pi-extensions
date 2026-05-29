/**
 * AWS EC2 API client backed by the AWS SDK v3.
 *
 * Uses `@aws-sdk/client-ec2` rather than shelling out to the `aws` CLI.
 * SDK clients are cached by `"profile:region"` so we don't recreate them
 * on every poll.
 */

import {
	DescribeInstancesCommand,
	EC2Client as AwsEc2Client,
	StartInstancesCommand,
	StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Ec2InstanceState } from "./types.js";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface InstanceStateResult {
	state?: Ec2InstanceState;
	nameTag?: string;
	stateTransitionReason?: string;
	availabilityZone?: string;
	instanceType?: string;
	/** Launch time of the instance. */
	launchTime?: Date;
	/** `true` when the instance does not exist in the given account/region. */
	notFound?: boolean;
}

// ---------------------------------------------------------------------------
// Client interface (injected in production, stubbed in tests)
// ---------------------------------------------------------------------------

export interface Ec2Client {
	describeInstance: (
		instanceId: string,
		profile: string,
		region: string | undefined,
	) => Promise<InstanceStateResult>;
	stopInstance: (instanceId: string, profile: string, region: string | undefined) => Promise<void>;
	startInstance: (instanceId: string, profile: string, region: string | undefined) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Error-name classification
// ---------------------------------------------------------------------------

const NOT_FOUND_NAMES = new Set([
	"InvalidInstanceID.NotFound",
	"InvalidInstanceId.NotFound",
]);

/**
 * Detect the narrow "instance not found" case.
 */
export function isNotFoundError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const name = (err as { name?: unknown }).name;
	if (typeof name === "string" && NOT_FOUND_NAMES.has(name)) return true;
	const metadata = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
	if (metadata && typeof metadata === "object") {
		const status = metadata.httpStatusCode;
		if (status === 404) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a real {@link Ec2Client} backed by the AWS SDK v3. */
export function createEc2Client(): Ec2Client {
	const clientCache = new Map<string, AwsEc2Client>();

	function getSdkClient(profile: string, region: string | undefined): AwsEc2Client {
		const key = `${profile}:${region ?? "<default>"}`;
		let c = clientCache.get(key);
		if (!c) {
			c = new AwsEc2Client({
				credentials: fromIni({ profile }),
				...(region !== undefined ? { region } : {}),
			});
			clientCache.set(key, c);
		}
		return c;
	}

	return {
		stopInstance: async (instanceId, profile, region) => {
			const sdk = getSdkClient(profile, region);
			await sdk.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
		},
		startInstance: async (instanceId, profile, region) => {
			const sdk = getSdkClient(profile, region);
			await sdk.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
		},
		async describeInstance(instanceId, profile, region) {
			try {
				const out = await getSdkClient(profile, region).send(
					new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
				);
				const instance = out.Reservations?.[0]?.Instances?.[0];
				if (!instance) return { notFound: true };

				const result: InstanceStateResult = {};
				const stateName = instance.State?.Name;
				if (typeof stateName === "string") {
					result.state = stateName;
				}
				const nameTag = instance.Tags?.find((t) => t.Key === "Name")?.Value;
				if (typeof nameTag === "string") result.nameTag = nameTag;
				if (typeof instance.StateTransitionReason === "string") {
					result.stateTransitionReason = instance.StateTransitionReason;
				}
				if (typeof instance.Placement?.AvailabilityZone === "string") {
					result.availabilityZone = instance.Placement.AvailabilityZone;
				}
				if (typeof instance.InstanceType === "string") {
					result.instanceType = instance.InstanceType;
				}
				if (instance.LaunchTime instanceof Date) {
					result.launchTime = instance.LaunchTime;
				}
				return result;
			} catch (err) {
				if (isNotFoundError(err)) return { notFound: true };
				throw err;
			}
		},
	};
}
