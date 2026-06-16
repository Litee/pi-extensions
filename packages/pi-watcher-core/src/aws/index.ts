/**
 * AWS utilities for pi watcher extensions.
 *
 * Re-exports all public symbols from the `pi-watcher-core/src/aws/` modules
 * so consumers can import from a single entry point:
 *
 * ```ts
 * import { AwsBaseWatcher, classifyAwsError, ... } from 'pi-watcher-core/aws'
 * ```
 */

export { AwsBaseWatcher } from './base-watcher.js'
export type { AwsWatchBase, AwsAddBaseParams } from './base-watcher.js'
export { AUTH_ERROR_NAMES, THROTTLE_ERROR_NAMES, classifyAwsError } from './classify-error.js'
export { createCachedSdkClientFactory } from './sdk-client-factory.js'
export { makeIsNotFoundError } from './not-found.js'
export { awsToolFields } from './tool-fields.js'
