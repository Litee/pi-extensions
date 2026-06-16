/**
 * Generic cache-by-(profile, region) factory for AWS SDK v3 service clients.
 *
 * Each AWS watcher package previously duplicated a ~15-line `getSdkClient`
 * closure. This factory captures the pattern once.
 *
 * @example
 * ```ts
 * const getSdkClient = createCachedSdkClientFactory(async (profile, region) => {
 *   const { EC2Client } = await import('@aws-sdk/client-ec2')
 *   const { fromIni } = await import('@aws-sdk/credential-providers')
 *   return new EC2Client({
 *     credentials: fromIni({ profile }),
 *     ...(region !== undefined ? { region } : {}),
 *   })
 * })
 * ```
 */

/**
 * Wraps an async `factory` function with a `"profile:region"` cache so that
 * SDK client instances are reused across calls with the same credentials.
 *
 * @param factory  Async function that constructs a fresh SDK client.
 * @returns        Cached getter with the same signature as `factory`.
 */
export function createCachedSdkClientFactory<T>(
  factory: (profile: string, region: string | undefined) => Promise<T>,
): (profile: string, region: string | undefined) => Promise<T> {
  const cache = new Map<string, T>()
  return async (profile: string, region: string | undefined): Promise<T> => {
    const key = `${profile}:${region ?? '<default>'}`
    let c = cache.get(key)
    if (!c) {
      c = await factory(profile, region)
      cache.set(key, c)
    }
    return c
  }
}
