/**
 * Shared TypeBox field definitions for AWS tool parameter schemas.
 *
 * Import and spread into a `Type.Object({...})` to avoid copy-pasting the
 * `profile` and `region` fields across every AWS watcher tool schema.
 *
 * @example
 * ```ts
 * import { Type } from 'typebox'
 * import { awsToolFields } from 'pi-watcher-core/aws/tool-fields'
 *
 * export const MyWatcherParams = Type.Object({
 *   action: Type.Union([...]),
 *   ...awsToolFields,
 * })
 * ```
 */

import { Type } from 'typebox'

export const awsToolFields = {
  profile: Type.Optional(
    Type.String({ description: "AWS credentials profile (required for 'add')." }),
  ),
  region: Type.Optional(
    Type.String({ description: 'AWS region. Falls back to profile default when omitted.' }),
  ),
}
