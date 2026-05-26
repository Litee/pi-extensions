/**
 * EC2 instance ID validation.
 *
 * Instance IDs follow the pattern `i-[0-9a-f]{8,17}`.
 */

const INSTANCE_ID_RE = /^i-[0-9a-f]{8,17}$/;

export class InstanceIdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InstanceIdError";
	}
}

/** Return `true` iff `id` looks like a valid EC2 instance ID. */
export function isValidInstanceId(id: unknown): id is string {
	if (typeof id !== "string") return false;
	return INSTANCE_ID_RE.test(id);
}

/**
 * Return `id` unchanged if valid; throw {@link InstanceIdError} otherwise.
 */
export function validateInstanceId(id: string): string {
	if (!isValidInstanceId(id)) {
		throw new InstanceIdError(
			`Invalid EC2 instance ID: ${JSON.stringify(id)}. ` +
				`Expected format: i-[0-9a-f]{8,17}`,
		);
	}
	return id;
}
