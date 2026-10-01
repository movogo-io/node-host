import { isIPv4 } from 'node:net'
import { performance } from 'node:perf_hooks'
import { highPrecisionISODate } from './host/logging.js'

export type Environment = {
    readonly [key: string]: string
}

export type Logger = {
    enrich(fields: JsonSafeObject): void
    trace(message: string, error?: unknown, fields?: JsonSafeObject): void
    debug(message: string, error?: unknown, fields?: JsonSafeObject): void
    info(message: string, error?: unknown, fields?: JsonSafeObject): void
    warn(message: string, error?: unknown, fields?: JsonSafeObject): void
    error(message: string, error?: unknown, fields?: JsonSafeObject): void
    fatal(message: string, error?: unknown, fields?: JsonSafeObject): void
}

export type MutableJson =
    null | boolean | number | string | MutableJson[] | { [key: string]: MutableJson }
export type Json = null | boolean | number | string | readonly Json[] | JsonObject
export type JsonObject = { readonly [key: string]: Json }

export type JsonSafe =
    | boolean
    | number
    | string
    | readonly JsonSafe[]
    | JsonSafeObject
    | { toJSON: () => string }
    | undefined
    | null

export type JsonSafeObject = { readonly [key: string]: JsonSafe }

/**
Attributes an emitter puts beside an event, for consumers to filter on. Exact strings only;
at most four, names matching `^[a-z][A-Za-z0-9]{0,63}$` and not reserved (see `host/attributes.ts`).
*/
export type EventAttributes = { readonly [name: string]: string }

/**
A handler's filter: every named attribute must be present on the event with a value strictly
equal to one of the listed values. Exact string values only.
*/
export type EventFilter = { readonly [attribute: string]: readonly [string, ...string[]] }

declare const attributionClaim: unique symbol

/**
Whom the current work is done on behalf of: opaque ids only, from a verified bearer or an
explicitly accepted forward. Branded with a declared symbol, so a hand-written literal is
refused where a claim is expected and a claim is never assignable where a caller is. The only
constructor is `claim()` in the host's internal `host/attribution.ts`, deliberately outside this
facade: service code never mints one. The symbol is a type-level fiction; the runtime object is
`{ userId, org? }`.
*/
export type AttributionClaim = {
    readonly userId: string
    readonly org?: string
    readonly [attributionClaim]: true
}

/**
One mutable holder per invocation, shared by every copy of the context, carrying the claim
to outgoing requests and emitted events. Never consulted for authorization.
*/
export type Attribution = { onBehalfOf?: AttributionClaim }

export type HandlerConfiguration = {
    /**
    An indication of CPU usage of the handler. If undefined, a generic conservative value will be used.
    */
    readonly compute?: 'high' | 'low'
    /**
    An indication of memory usage of the handler. If undefined, a generic conservative value will be used.
    */
    readonly memory?: 'high' | 'low'
    /**
    A boolean indicating whether to enrich the log with the body of events, requests or responses. Set to false if the body is large or contain very sensitive data.
    @default false
    */
    readonly excludeBodyFromLogs?: boolean
    /**
    The level below which log entries will be discarded.
    @default 'trace'
    */
    readonly minimumLogLevel?: 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'
    /**
    The number of seconds the function is expected to finish executing in.
    */
    readonly timeout?: number
    /**
    For event handlers: only events carrying every named attribute with a value strictly equal
    to one of the listed values are delivered. Exact string values only; the sanctioned source
    for announcements is the contract package's helpers.
    */
    readonly filter?: EventFilter
}

export type Context = {
    readonly env: Environment
    readonly log: Logger
    readonly signal: AbortSignal
    now(): Date

    readonly operationId?: string
    readonly client?: {
        readonly id?: string
        readonly ip?: string
        readonly port?: number
        readonly userAgent?: string
        /**
        The request id the client sent, kept apart from the minted `operationId`.
        */
        readonly requestId?: string
    }
    readonly attribution: Attribution
    readonly meta?: {
        readonly packageName: string
        readonly fileName: string
        readonly revision?: string
    }

    emit(
        topic: string,
        type: string,
        subject: string,
        data?: Json,
        messageId?: string,
        attributes?: EventAttributes,
    ): Promise<void>

    onSuccess(fn: () => Promise<void> | void): void
}

export function httpRequestHeaders({
    meta,
    operationId,
    client,
    attribution,
}: Pick<Context, 'meta' | 'operationId' | 'client'> & Partial<Pick<Context, 'attribution'>>) {
    const headers: { [key: string]: string } = {
        'user-agent': `${meta?.packageName ?? '?'}/${meta?.revision ?? '?'}`,
    }
    if (operationId) {
        headers['x-request-id'] = operationId
    }
    if (attribution?.onBehalfOf) {
        headers['x-on-behalf-of-user-id'] = attribution.onBehalfOf.userId
        if (attribution.onBehalfOf.org) {
            headers['x-on-behalf-of-org'] = attribution.onBehalfOf.org
        }
    }
    if (client) {
        if (client.id) {
            headers['x-client-id'] = client.id
        }
        const { ip, port } = client
        if (!!ip || !!port) {
            const xff = forwardedFor(ip, port)
            if (xff) {
                headers['x-forwarded-for'] = xff
            }
        }
        if (client.userAgent) {
            headers['x-forwarded-for-user-agent'] = client.userAgent
        }
    }
    return headers
}

function forwardedFor(ip: string | undefined, port: number | undefined) {
    if (!port) {
        if (ip) {
            return ip
        }
        return undefined
    }
    if (!ip) {
        return `:${port}`
    }
    if (isIPv4(ip)) {
        return `${ip}:${port}`
    }
    return `[${ip}]:${port}`
}

export async function measure<T>(
    logger: { trace: (message: string, _: undefined, f: JsonSafeObject) => void },
    name: string,
    fn: () => Promise<T> | T,
    fields?: JsonSafeObject,
) {
    const start = performance.now()
    try {
        return await fn()
    } finally {
        const end = performance.now()
        logger.trace(`Measurement of ${name} time`, undefined, {
            start: highPrecisionISODate(start),
            end: highPrecisionISODate(end),
            duration: (Math.round(end * 10_000) - Math.round(start * 10_000)) / 10_000,
            ...fields,
        })
    }
}
