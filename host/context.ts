import {
    Context,
    Environment,
    Json,
    Logger,
    type Attribution,
    type EventAttributes,
    type JsonSafeObject,
} from '../context.js'
import { validateEventAttributes, validateEventSubject } from './attributes.js'
import { makeLogger } from './logging.js'
import type { FullConfiguration, Metadata } from './meta.js'

export type ClientInfo = {
    readonly operationId?: string
    readonly clientId?: string
    readonly clientIp?: string
    readonly clientPort?: number
    readonly userAgent?: string
    /**
    The request id the client sent (bounded, printable ASCII), never the operation id.
    */
    readonly clientRequestId?: string
}

export type EventTransport = {
    sendEvent(
        topic: string,
        type: string,
        subject: string,
        data: JsonSafeObject | undefined,
        messageId: string | undefined,
        signal: AbortSignal,
        extras?: { attributes?: EventAttributes; attribution?: Attribution },
    ): Promise<void>
}

/**
Marks the context's emit function as one that accepts attributes. The same function object
sits on every spread copy of the context, so the marker survives `{ ...context }`.
*/
export const emitAttributesMarker: unique symbol = Symbol.for('movogo.emit.attributes')

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'

export type LogEntry = {
    readonly level: LogLevel
    readonly timestamp: number
    readonly message: string
    readonly error: unknown
    readonly json: string
}

export type LogTransport = {
    readonly publishRate?: number
    sendEntries(entries: LogEntry[], signal: AbortSignal): Promise<void> | undefined | void
}

class LogMulticaster implements LogTransport {
    readonly publishRate: number
    readonly #transports: LogTransport[]

    constructor(transports: LogTransport[]) {
        this.#transports = transports
        this.publishRate = Math.min(
            ...transports.map(t => t.publishRate ?? Number.MAX_SAFE_INTEGER),
            Number.MAX_SAFE_INTEGER,
        )
    }

    sendEntries(entries: LogEntry[], signal: AbortSignal) {
        const promises = this.#transports.map(t => t.sendEntries(entries, signal)).filter(p => !!p)
        if (promises.length === 0) {
            return
        }
        return Promise.all(promises) as unknown as Promise<void>
    }
}

export type RootLogger = {
    enrichReserved(fields: object): RootLogger
    flush(): Promise<void>
} & Logger

export function createContext(
    clientInfo: ClientInfo,
    loggers: LogTransport[],
    eventTransport: EventTransport,
    timeouts: { default: number; cap?: number },
    outerController: AbortController,
    config?: FullConfiguration,
    meta?: Metadata,
    environment?: Partial<Environment>,
    now?: () => Date,
    attribution?: Attribution,
): {
    log: RootLogger
    context: Omit<Context, 'log'>
    success: () => Promise<unknown>
    flush: () => Promise<void>
} {
    const timeout =
        (timeouts.cap
            ? Math.min(config?.timeout ?? timeouts.default, timeouts.cap)
            : (config?.timeout ?? timeouts.default)) * 1000
    const innerController = new AbortController()

    const logTransport =
        (loggers.length === 1 ? loggers[0] : undefined) ?? new LogMulticaster(loggers)
    const logger = makeLogger(
        logTransport,
        config?.minimumLogLevel,
        outerController.signal,
    ).enrichReserved({
        operationId: clientInfo.operationId,
        client: {
            id: clientInfo.clientId,
            ip: clientInfo.clientIp,
            port: clientInfo.clientPort,
            userAgent: clientInfo.userAgent,
            requestId: clientInfo.clientRequestId,
        },
    })
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function
    globalLogger = logger
    const successHandlers: (() => Promise<void> | void)[] = []
    const holder: Attribution = attribution ?? {}
    // Async so a refused subject or attribute rejects, as every other failed emit does.
    const emit = async (
        topic: string,
        type: string,
        subject: string,
        data?: {
            readonly [key: string]: Json
        },
        messageId?: string,
        attributes?: EventAttributes,
    ) => {
        validateEventSubject(subject)
        validateEventAttributes(attributes)
        await eventTransport.sendEvent(
            topic,
            type,
            subject,
            data,
            messageId,
            outerController.signal,
            { attributes, attribution: holder },
        )
    }
    Object.defineProperty(emit, emitAttributesMarker, { value: true })
    const ctx = {
        env: (environment ?? process.env) as Environment,
        signal: innerController.signal,
        now: now ?? (() => new Date()),
        operationId: clientInfo.operationId,
        client: {
            id: clientInfo.clientId,
            ip: clientInfo.clientIp,
            port: clientInfo.clientPort,
            userAgent: clientInfo.userAgent,
            requestId: clientInfo.clientRequestId,
        },
        attribution: holder,
        meta: meta
            ? {
                  packageName: meta.packageName,
                  fileName: meta.fileName,
                  revision: meta.revision,
              }
            : undefined,
        emit,
        onSuccess: (fn: () => Promise<void> | void) => {
            successHandlers.push(fn)
        },
    }
    const timeoutHandle = setTimeout(() => {
        logger.error('Timeout.', undefined, undefined)
        innerController.abort()
        // eslint-disable-next-line no-void
        void logger.flush()
    }, timeout)
    const flushHandle = setTimeout(() => {
        logger.error('Aborting flush.', undefined, undefined)
        outerController.abort()
    }, timeout + 15_000)
    return {
        log: logger,
        context: ctx,
        success: () => Promise.all(successHandlers.map(fn => fn()).filter(r => !!r)),
        flush: async () => {
            clearTimeout(timeoutHandle)
            await logger.flush()
            clearTimeout(flushHandle)
        },
    }
}

let globalLogger: Logger | undefined

// eslint-disable-next-line unicorn/no-top-level-side-effects
process.on('uncaughtException', err => {
    globalLogger?.fatal('Uncaught exception.', err, undefined)
})
// eslint-disable-next-line unicorn/no-top-level-side-effects
process.on('unhandledRejection', reason => {
    globalLogger?.fatal('Unhandled rejection.', reason, undefined)
})
