import { hash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { brotliCompress } from 'node:zlib'
import { Context, measure } from '../context.js'
import type { Json, ParsedUrl, ResponseHeaders, Result } from '../http.js'
import { ClientInfo, RootLogger } from './context.js'
import type { HttpHandler } from './http-registry.js'

export type Response = {
    headers: { readonly [key: string]: string }
    status: number
    body?: string | Buffer
}

type RequestOptions = BodylessRequestOptions | StringRequestOptions | JsonRequestOptions

type BodylessRequestOptions = {
    uri: string
    headers?: { readonly [key: string]: string }
}

type StringRequestOptions = BodylessRequestOptions & {
    body: string
}

type JsonRequestOptions = BodylessRequestOptions & {
    json: Json
}

export async function executeRequest(
    log: RootLogger,
    context: Omit<Context, 'log'>,
    handler: HttpHandler,
    options: RequestOptions,
    success: () => Promise<unknown>,
): Promise<Response> {
    const isShallow =
        context.env.SHALLOW_KEY && options.headers?.['x-shallow'] === context.env.SHALLOW_KEY
    const includeBodyInLogs = !handler.config?.excludeBodyFromLogs
    const loggedOptions = {
        method: handler.method,
        ...options,
        headers: redactedHeaders(options.headers),
    }
    const logRequest = includeBodyInLogs ? loggedOptions : withoutRequestBody(loggedOptions)
    let enrichedLog = log.enrichReserved({ meta: context.meta, request: logRequest })
    if (isShallow) {
        enrichedLog.trace('Shallow request')
        return withRequestId({ headers: {}, status: 204 }, context.operationId)
    }
    enrichedLog.trace('Request BEGIN')
    try {
        let parsedUrl:
            | (ParsedUrl & {
                  /**
                  @ignore
                  */
                  __proto__: unknown
                  /**
                  @ignore
                  */
                  toString: () => string
              })
            | undefined
        let pathSteps: string[] | undefined
        const req = {
            rawUrl: options.uri,
            get url() {
                if (parsedUrl) {
                    return parsedUrl
                }
                // eslint-disable-next-line unicorn/no-this-outside-of-class
                const url = new URL(this.rawUrl)
                parsedUrl = {
                    // eslint-disable-next-line unicorn/no-null
                    __proto__: null,
                    hash: url.hash,
                    host: url.host,
                    hostname: url.hostname,
                    href: url.href,
                    origin: url.origin,
                    password: url.password,
                    pathname: url.pathname,
                    port: url.port,
                    protocol: url.protocol,
                    search: url.search,
                    get searchParams() {
                        return url.searchParams
                    },
                    toJSON: () => url.toJSON(),
                    // eslint-disable-next-line unicorn/prefer-url-href
                    toString: () => url.toString(),
                    username: url.username,
                    pathStepAt: (index: number) => {
                        const steps = (pathSteps ??= url.pathname.split('/'))
                        const step = steps[index + 1]
                        if (!step) {
                            throw Object.assign(
                                new RangeError(`Path does not have a step at index ${index}.`),
                                {
                                    // eslint-disable-next-line unicorn/no-this-outside-of-class
                                    rawUrl: this.rawUrl,
                                    pathName: url.pathname,
                                    steps: steps.slice(1),
                                },
                            )
                        }
                        return step
                    },
                }
                return parsedUrl
            },
            body: requestBody(options),
            headers: options.headers ?? {},
        }

        const result = await measure(log.enrichReserved({ meta: context.meta }), 'execution', () =>
            handler.entry({ ...context, log: enrichedLog }, req),
        )

        const response = withRequestId(
            resultToResponse(result, includeBodyInLogs),
            context.operationId,
        )

        if (context.signal.aborted) {
            response.headers = {
                'x-timeout': '1',
                ...response.headers,
            }
        }

        enrichedLog = enrichedLog.enrichReserved({
            response: {
                status: response.status,
                headers: response.headers,
                body: response.logBody,
            },
        })
        if (response.status < 300) {
            enrichedLog.debug('Request END')
            await success()
        } else {
            enrichedLog.warn('Request END')
        }
        return await compressed(req.headers, eTagged(req.headers, response))
    } catch (e) {
        try {
            const response = withRequestId(errorToResponse(e), context.operationId)
            enrichedLog = enrichedLog.enrichReserved({ response })
            enrichedLog.error('Request END', e)
            return response
        } catch (convertError) {
            enrichedLog.error('Could not convert exception to error response.', convertError)
            return withRequestId({ headers: {}, status: 500 }, context.operationId)
        }
    }
}

function resultToResponse(result: Result, withLogBody: boolean): Response & { logBody?: unknown } {
    if (!result) {
        return {
            headers: {},
            status: 204,
        }
    }
    if (typeof result === 'string') {
        const logBody = withLogBody ? result : undefined
        return {
            headers: {
                'content-type': 'text/plain',
            },
            status: 200,
            body: result,
            logBody,
        }
    }
    if (result.body === undefined) {
        return {
            headers: result.headers ?? {},
            status: result.status ?? 200,
        }
    }
    if (typeof result.body === 'string') {
        const logBody = withLogBody ? result.body : undefined
        return {
            headers: withContentType(result.headers, 'text/plain'),
            status: result.status ?? 200,
            body: result.body,
            logBody,
        }
    }
    if (Buffer.isBuffer(result.body)) {
        const logBody = withLogBody ? result.body.toString('base64') : undefined
        return {
            headers: withContentType(result.headers, 'application/octet-stream'),
            status: result.status ?? 200,
            body: result.body,
            logBody,
        }
    }
    const logBody = withLogBody ? result.body : undefined
    return {
        headers: withContentType(result.headers, 'application/json'),
        status: result.status ?? 200,
        body: JSON.stringify(result.body),
        logBody,
    }
}

// Every response echoes the operation id the logs carry, so a client can quote it; a value
// the handler set would break that join, so the minted id wins.
function withRequestId<T extends Response>(response: T, operationId: string | undefined): T {
    if (!operationId) {
        return response
    }
    response.headers = {
        ...response.headers,
        'x-request-id': operationId,
    }
    return response
}

const redactedHeaderNames = new Set(['authorization', 'api-key', 'x-shallow'])

function redactedHeaders(headers: { readonly [key: string]: string } | undefined) {
    if (!headers) {
        return undefined
    }
    return Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
            name,
            isRedactedHeader(name) ? '[redacted]' : value,
        ]),
    )
}

function isRedactedHeader(name: string) {
    const lowerCase = name.toLowerCase()
    return redactedHeaderNames.has(lowerCase) || lowerCase.startsWith('x-on-behalf-of-')
}

function withoutRequestBody(options: RequestOptions & { method: string }) {
    if ('json' in options) {
        const { json, ...bodyless } = options
        return bodyless
    }
    if ('body' in options) {
        const { body, ...bodyless } = options
        return bodyless
    }
    return options
}

function requestBody(options: RequestOptions): Json | string | undefined {
    if ('json' in options) {
        return options.json
    }
    if ('body' in options) {
        return options.body
    }
    return undefined
}

function withContentType(headers: ResponseHeaders | undefined, contentType: string) {
    if (!headers) {
        return {
            'content-type': contentType,
        }
    }
    headers['content-type'] ??= contentType
    return headers
}

function errorToResponse(e: unknown): Response {
    const { body, statusCode: status } = e as { body?: unknown; statusCode?: number }
    if (typeof body === 'string') {
        return {
            headers: {
                'content-type': 'text/plain',
            },
            status: status ?? 500,
            body,
        }
    }
    if (typeof body === 'object') {
        return {
            headers: {
                'content-type': 'application/json',
            },
            status: status ?? 500,
            body: JSON.stringify(body),
        }
    }
    return {
        headers: {},
        status: status ?? 500,
    }
}

/**
Mints the operation id for every request: a client's own request id is kept apart as
`clientRequestId`, so it can be joined on in logs but never names our work. The
`x-on-behalf-of-*` headers are not read here; a route accepts them explicitly or not at all.
*/
export function clientFromHeaders(
    headers: { readonly [key: string]: string | undefined } | undefined,
): ClientInfo {
    const operationId = randomUUID()
    if (!headers) {
        return { operationId }
    }
    return {
        operationId,
        clientRequestId: boundedClientRequestId(headers['x-request-id'] ?? headers['request-id']),
        clientId:
            headers['x-client-id'] ??
            headers['x-installation-id'] ??
            headers['client-id'] ??
            headers['installation-id'],
        ...clientAddress(headers),
        userAgent: headers['x-forwarded-for-user-agent'] ?? headers['user-agent'],
    }
}

const clientRequestIdPattern = /^[\u{20}-\u{7E}]{1,128}$/u

function boundedClientRequestId(value: string | undefined) {
    if (value === undefined || !clientRequestIdPattern.test(value)) {
        return undefined
    }
    return value
}

function clientAddress(headers: { readonly [key: string]: string | undefined }) {
    const xff = headers['x-forwarded-for']
    if (!xff) {
        return undefined
    }
    for (const a of xff.split(',')) {
        const valid = validClientAddress(a.trim())
        if (valid) {
            return valid
        }
    }
    return undefined
}

function validClientAddress(s: string) {
    const version = isIP(s)
    if (version === 4) {
        return { clientIp: s }
    }
    if (version === 6) {
        return normalizedIp6(s)
    }
    if (s.startsWith('[') && s.endsWith(']')) {
        return normalizedIp6(s.slice(1, -1))
    }
    if (s.startsWith(':')) {
        const clientPort = Number(s.slice(1))
        if (Number.isFinite(clientPort)) {
            return { clientPort }
        }
        return undefined
    }
    const url = `ip://${s}/`
    if (URL.canParse(url)) {
        return addressFromUrl(new URL(url))
    }
    return undefined
}

function normalizedIp6(s: string) {
    const mapped = mappedAddress(s)
    if (mapped) {
        return { clientIp: mapped }
    }
    const url = new URL(`ip://[${s}]/`)
    return { clientIp: url.hostname.slice(1, -1) }
}

function addressFromUrl(url: URL) {
    const clientIp =
        url.hostname.startsWith('[') && url.hostname.endsWith(']')
            ? url.hostname.slice(1, -1)
            : url.hostname
    const clientPort = url.port ? Number(url.port) : undefined
    if (isIP(clientIp)) {
        return {
            clientIp,
            clientPort,
        }
    }
    return undefined
}

function mappedAddress(s: string) {
    if (s.startsWith('::ffff:')) {
        const ip4 = s.slice(7)
        if (isIP(ip4) === 4) {
            return ip4
        }
    }
    return undefined
}

function eTagged(
    requestHeaders: { [key: string]: string },
    response: Response & { headers: { [key: string]: string } },
): Response {
    if (response.headers.etag || !response.body) {
        return response
    }
    const etag = hash('sha1', response.body, 'base64').slice(0, -1)
    response.headers.etag = etag
    if (requestHeaders['if-none-match'] === etag) {
        response.status = 304
        delete response.body
    }
    return response
}

async function compressed(
    requestHeaders: { [key: string]: string },
    response: Response & { headers: { [key: string]: string } },
): Promise<Response> {
    if (!response.body || response.body.length < 32_768 || response.headers['content-encoding']) {
        return response
    }
    const encodings = requestHeaders['accept-encoding']?.split(',').map(e => e.trim())
    if (!encodings?.includes('br')) {
        return response
    }
    return {
        status: response.status,
        headers: {
            'content-encoding': 'br',
            ...response.headers,
        },
        body: await compress(response.body),
    }
}

function compress(body: string | Buffer) {
    return new Promise<Buffer>((resolve, reject) => {
        brotliCompress(body, {}, (error, result) => {
            if (error) {
                reject(error)
                return
            }
            resolve(result)
        })
    })
}
