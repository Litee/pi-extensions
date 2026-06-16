/**
 * Factory for AWS "resource not found" error predicates.
 *
 * AWS SDK v3 surfaces 404-style errors as named error objects (e.g.
 * `"NotFound"`, `"NoSuchKey"`, `"InvalidInstanceID.NotFound"`) or via the
 * `$metadata.httpStatusCode === 404` property.
 *
 * `makeIsNotFoundError` captures these two checks in a single reusable
 * predicate so that each AWS client only needs to supply the service-specific
 * error-name set.
 */

/**
 * Create an "is this a not-found error?" predicate for the given name set.
 *
 * @param names  Set of AWS SDK v3 error `.name` values that represent a
 *               "resource does not exist" condition for a specific service.
 */
export function makeIsNotFoundError(
  names: ReadonlySet<string>,
): (err: unknown) => boolean {
  return (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string' && names.has(name)) return true
    const metadata = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata
    if (metadata && typeof metadata === 'object') {
      const status = metadata.httpStatusCode
      if (status === 404) return true
    }
    return false
  }
}
