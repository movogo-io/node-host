import type { AttributionClaim } from '../context.js'

/**
The only constructor of an attribution claim, kept out of the `lib/*` facade that
`@movogo-io/service` re-exports so that service code cannot mint one: a claim is set where a
bearer was verified (`getBearer`), where a forwarded one is accepted after an api-key check
(`acceptForwardedAttribution`), where the bus restored it (the aws-host) and where a test seeds
it (the mock). Timers, sweeps and operator retries set nothing.
*/
export function claim(userId: string, org?: string): AttributionClaim {
    return (org === undefined ? { userId } : { userId, org }) as AttributionClaim
}
