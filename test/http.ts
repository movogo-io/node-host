import assert from 'node:assert/strict'
import {
    createContext,
    type EventTransport,
    type LogEntry,
    type LogTransport,
} from '../host/context.js'
import { clientFromHeaders, executeRequest } from '../host/http.js'
import {
    acceptForwardedAttribution,
    httpRequestHeaders,
    type Attribution,
    type Context,
    type EventAttributes,
    type Handler,
    type JsonSafeObject,
} from '../http.js'

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u

describe('http', () => {
    describe('client info', () => {
        it('mints a distinct operation id per request, also without headers', () => {
            const first = clientFromHeaders(undefined)
            const second = clientFromHeaders({})
            assert.match(first.operationId ?? '', uuidPattern)
            assert.match(second.operationId ?? '', uuidPattern)
            assert.notStrictEqual(first.operationId, second.operationId)
        })

        it('keeps the request id the client sent apart from the operation id', () => {
            const { operationId, ...client } = clientFromHeaders({ 'x-request-id': 'abc' })
            assert.match(operationId ?? '', uuidPattern)
            assert.deepStrictEqual(withoutUndefined(client), { clientRequestId: 'abc' })
        })

        it('drops a client request id that is too long or not printable ASCII', () => {
            for (const value of ['a'.repeat(129), 'tab\there', 'ø', '']) {
                const { operationId, ...client } = clientFromHeaders({ 'x-request-id': value })
                assert.deepStrictEqual(withoutUndefined(client), {}, JSON.stringify(value))
            }
        })

        it('keeps a client request id of up to 128 printable ASCII characters', () => {
            const { operationId, ...client } = clientFromHeaders({
                'request-id': 'a'.repeat(128),
            })
            assert.deepStrictEqual(withoutUndefined(client), { clientRequestId: 'a'.repeat(128) })
        })

        it('never reads the on-behalf-of headers', () => {
            const { operationId, ...client } = clientFromHeaders({
                'x-on-behalf-of-user-id': 'user-1',
                'x-on-behalf-of-org': 'org-1',
            })
            assert.deepStrictEqual(withoutUndefined(client), {})
        })
    })

    describe('parses forwarded header', () => {
        // eslint-disable-next-line unicorn/consistent-function-scoping
        const internal = (client: { ip?: string; port?: number }) =>
            httpRequestHeaders({ client })['x-forwarded-for']

        for (const [actual, expected] of [
            ['xyz', {}],
            ['1.2.3.4', { clientIp: '1.2.3.4' }],
            [internal({ ip: '1.2.3.4' }), { clientIp: '1.2.3.4' }],
            ['1.002.003.4', {}],
            ['1.2.3.4, 2.3.4.5', { clientIp: '1.2.3.4' }],
            ['1.2.3.4:56', { clientIp: '1.2.3.4', clientPort: 56 }],
            [':56', { clientPort: 56 }],
            [internal({ port: 56 }), { clientPort: 56 }],
            ['xyz, 1.2.3.4:56', { clientIp: '1.2.3.4', clientPort: 56 }],
            ['1.2.3.4:56,2.3.4.5:67', { clientIp: '1.2.3.4', clientPort: 56 }],
            ['1.2.3.4:56, 2.3.4.5:67', { clientIp: '1.2.3.4', clientPort: 56 }],
            ['203.0.113.195, 70.41.3.18, 150.172.238.178', { clientIp: '203.0.113.195' }],
            ['203.0.113.195', { clientIp: '203.0.113.195' }],
            [
                '2001:db8:85a3:8d3:1319:8a2e:370:7348',
                { clientIp: '2001:db8:85a3:8d3:1319:8a2e:370:7348' },
            ],
            [
                internal({ ip: '2001:db8:85a3:8d3:1319:8a2e:370:7348' }),
                { clientIp: '2001:db8:85a3:8d3:1319:8a2e:370:7348' },
            ],
            [
                '203.0.113.195:41237, 198.51.100.100:38523',
                { clientIp: '203.0.113.195', clientPort: 41_237 },
            ],
            [
                '[2001:db8::1a2b:3c4d]:41237, 198.51.100.100:26321',
                { clientIp: '2001:db8::1a2b:3c4d', clientPort: 41_237 },
            ],
            [
                internal({ ip: '2001:db8::1a2b:3c4d', port: 41_237 }),
                { clientIp: '2001:db8::1a2b:3c4d', clientPort: 41_237 },
            ],
            ['2001:db8::aa:bb', { clientIp: '2001:db8::aa:bb' }],
            ['[2001:db8::aa:bb]', { clientIp: '2001:db8::aa:bb' }],
            ['[2001:db8::1234]', { clientIp: '2001:db8::1234' }],
            ['2404:0068:0000:0000:0000:0000:0000:0000', { clientIp: '2404:68::' }],
            ['[2404:0068:0000:0000:0000:0000:0000:0000]', { clientIp: '2404:68::' }],
            [
                '[2404:0068:0000:0000:0000:0000:0000:0000]:23',
                { clientIp: '2404:68::', clientPort: 23 },
            ],
            ['[0000:0000:0000:0000:0000:0000:0000:0001]', { clientIp: '::1' }],
            ['0000:0000:0000:0000:0000:0000:0000:0001', { clientIp: '::1' }],
            ['::ffff:192.168.1.1', { clientIp: '192.168.1.1' }],
            ['[::ffff:192.168.1.1]', { clientIp: '192.168.1.1' }],
            ['[::ffff:192.168.1.1]:23', { clientIp: '::ffff:c0a8:101', clientPort: 23 }], // Not ideal
        ] as const) {
            it(actual ?? 'undefined', () => {
                const { operationId, ...client } = clientFromHeaders({
                    'x-forwarded-for': actual,
                })
                assert.deepStrictEqual(withoutUndefined(client), withoutUndefined(expected))
            })
        }
    })

    it('handles text response', async () => {
        const { response, operationId } = await executeHandler(() => {
            return {
                body: 'response body',
            }
        })
        assert.deepStrictEqual(response, {
            status: 200,
            headers: {
                'content-type': 'text/plain',
                // spell-checker: ignore Igudy LRMQE
                etag: 'ts/27mdLU5IgudyELJkBNcLRMQE',
                'x-request-id': operationId,
            },
            body: 'response body',
        })
    })

    it('handles object response', async () => {
        const { response, operationId } = await executeHandler(() => {
            return {
                body: { message: 'response body' },
            }
        })
        assert.deepStrictEqual(response, {
            status: 200,
            headers: {
                'content-type': 'application/json',
                etag: 'ZwAoZBg/P7JfAVoj+eS6P814iKk',
                'x-request-id': operationId,
            },
            body: '{"message":"response body"}',
        })
    })

    it('echoes the minted operation id on every response', async () => {
        const empty = await executeHandler(() => {
            //
        })
        assert.match(empty.operationId ?? '', uuidPattern)
        assert.deepStrictEqual(empty.response, {
            status: 204,
            headers: {
                'x-request-id': empty.operationId,
            },
        })

        const failed = await executeHandler(() => {
            throw new Error('boom')
        })
        assert.deepStrictEqual(failed.response, {
            status: 500,
            headers: {
                'x-request-id': failed.operationId,
            },
        })
    })

    it('echoes the minted operation id over one the handler set', async () => {
        const { response, operationId } = await executeHandler(() => {
            return {
                headers: { 'x-request-id': 'mine' },
            }
        })
        assert.deepStrictEqual(response, {
            status: 200,
            headers: {
                'x-request-id': operationId,
            },
        })
    })

    it('echoes the minted operation id on a shallow request', async () => {
        const { response, operationId, entries } = await executeHandler(
            () => {
                throw new Error('never reached')
            },
            { 'x-shallow': 'warm' },
            { SHALLOW_KEY: 'warm' },
        )
        assert.deepStrictEqual(response, {
            status: 204,
            headers: {
                'x-request-id': operationId,
            },
        })
        assert.deepStrictEqual(
            entries.map(e => e.message),
            ['Shallow request'],
        )
    })

    it('handles etag caching', async () => {
        const uncached = await executeHandler(() => {
            return {
                body: { message: 'response body' },
            }
        })
        const { etag: etag1 } = uncached.response.headers
        assert.ok(etag1)
        const { response, operationId } = await executeHandler(
            () => {
                return {
                    body: { message: 'response body' },
                }
            },
            {
                'if-none-match': etag1,
            },
        )
        assert.deepStrictEqual(response, {
            status: 304,
            headers: {
                'content-type': 'application/json',
                etag: 'ZwAoZBg/P7JfAVoj+eS6P814iKk',
                'x-request-id': operationId,
            },
        })

        const { etag: etag2 } = uncached.response.headers
        assert.ok(etag2)
        const changed = await executeHandler(
            () => {
                return {
                    body: { message: 'new response body' },
                }
            },
            {
                'if-none-match': etag2,
            },
        )
        assert.deepStrictEqual(changed.response, {
            status: 200,
            headers: {
                'content-type': 'application/json',
                // spell-checker: ignore Ashk
                etag: 'Va6G6GT8Ashk7WoEvX3TvNwV+Fs',
                'x-request-id': changed.operationId,
            },
            body: '{"message":"new response body"}',
        })
    })

    it('compresses large responses', async () => {
        const { response } = await executeHandler(
            () => {
                return {
                    body: {
                        message: Array.from({ length: 100_000 }, _ => 'hello'),
                    },
                }
            },
            {
                'accept-encoding': 'gzip, deflate, br, zstd',
            },
        )
        assert.deepStrictEqual(response.headers['content-encoding'], 'br')
        assert.ok((response.body?.length ?? NaN) < 10_000)
    })

    it('redacts credentials and on-behalf-of headers from the request log', async () => {
        const { entries } = await executeHandler(
            () => {
                //
            },
            {
                accept: 'text/plain',
                authorization: 'Bearer secret',
                'api-key': 'secret',
                'x-shallow': 'secret',
                'x-on-behalf-of-user-id': 'user-1',
                'x-on-behalf-of-org': 'org-1',
            },
        )
        assert.deepStrictEqual(
            entries
                .filter(e => e.message === 'Request BEGIN')
                .map(e => JSON.parse(e.json)?.request),
            [
                {
                    method: 'GET',
                    uri: '',
                    headers: {
                        accept: 'text/plain',
                        authorization: '[redacted]',
                        'api-key': '[redacted]',
                        'x-shallow': '[redacted]',
                        'x-on-behalf-of-user-id': '[redacted]',
                        'x-on-behalf-of-org': '[redacted]',
                    },
                },
            ],
        )
    })

    describe('attribution', () => {
        it('accepts a forwarded claim once and refuses a different one', () => {
            const context: Pick<Context, 'attribution'> = { attribution: {} }

            acceptForwardedAttribution(context, { headers: {} })
            acceptForwardedAttribution(context, { headers: { 'x-on-behalf-of-org': 'org-1' } })
            assert.deepStrictEqual(context, { attribution: {} })

            acceptForwardedAttribution(context, {
                headers: { 'x-on-behalf-of-user-id': 'user-1', 'x-on-behalf-of-org': 'org-1' },
            })
            acceptForwardedAttribution(context, {
                headers: { 'x-on-behalf-of-user-id': 'user-1', 'x-on-behalf-of-org': 'org-1' },
            })
            assert.deepStrictEqual(context, {
                attribution: { onBehalfOf: { userId: 'user-1', org: 'org-1' } },
            })

            assert.throws(
                () => {
                    acceptForwardedAttribution(context, {
                        headers: { 'x-on-behalf-of-user-id': 'user-2' },
                    })
                },
                {
                    message:
                        'Refusing to overwrite the attribution set from the bearer with a forwarded one.',
                },
            )
            assert.throws(
                () => {
                    acceptForwardedAttribution(context, {
                        headers: { 'x-on-behalf-of-user-id': 'user-1' },
                    })
                },
                {
                    message:
                        'Refusing to overwrite the attribution set from the bearer with a forwarded one.',
                },
            )
        })

        it('accepts a forwarded claim without an org', () => {
            const context: Pick<Context, 'attribution'> = { attribution: {} }
            acceptForwardedAttribution(context, {
                headers: { 'x-on-behalf-of-user-id': 'user-1', 'x-on-behalf-of-org': '' },
            })
            assert.deepStrictEqual(context, { attribution: { onBehalfOf: { userId: 'user-1' } } })
        })

        it('reads the forwarded headers whatever their case, as the REST payload keeps it', () => {
            const context: Pick<Context, 'attribution'> = { attribution: {} }
            acceptForwardedAttribution(context, {
                headers: { 'X-On-Behalf-Of-User-Id': 'user-1', 'X-On-Behalf-Of-Org': 'org-1' },
            })
            assert.deepStrictEqual(context, {
                attribution: { onBehalfOf: { userId: 'user-1', org: 'org-1' } },
            })
        })

        it('ignores a forged on-behalf-of header on a public route', async () => {
            const { operationId, events } = await executeHandler(
                async context => {
                    await context.emit('topic', 'type', 'subject', httpRequestHeaders(context))
                },
                {
                    'x-on-behalf-of-user-id': 'user-1',
                    'x-on-behalf-of-org': 'org-1',
                },
            )
            assert.deepStrictEqual(events, [
                {
                    topic: 'topic',
                    type: 'type',
                    subject: 'subject',
                    data: {
                        'user-agent': '?/?',
                        'x-request-id': operationId,
                    },
                    messageId: undefined,
                    extras: { attributes: undefined, attribution: {} },
                },
            ])
        })

        it('ignores a forwarded claim on an api-key route that does not accept it', async () => {
            const { operationId, events } = await executeHandler(
                async (context, request) => {
                    assert.strictEqual(request.headers['api-key'], 'secret')
                    await context.emit('topic', 'type', 'subject', httpRequestHeaders(context))
                },
                {
                    'api-key': 'secret',
                    'x-on-behalf-of-user-id': 'user-1',
                    'x-on-behalf-of-org': 'org-1',
                },
            )
            assert.deepStrictEqual(events, [
                {
                    topic: 'topic',
                    type: 'type',
                    subject: 'subject',
                    data: {
                        'user-agent': '?/?',
                        'x-request-id': operationId,
                    },
                    messageId: undefined,
                    extras: { attributes: undefined, attribution: {} },
                },
            ])
        })

        it('carries an accepted claim to outgoing requests and emitted events', async () => {
            const { operationId, events } = await executeHandler(
                async (context, request) => {
                    assert.strictEqual(request.headers['api-key'], 'secret')
                    acceptForwardedAttribution(context, request)
                    await context.emit('topic', 'type', 'subject', httpRequestHeaders(context))
                },
                {
                    'api-key': 'secret',
                    'x-on-behalf-of-user-id': 'user-1',
                    'x-on-behalf-of-org': 'org-1',
                },
            )
            assert.deepStrictEqual(events, [
                {
                    topic: 'topic',
                    type: 'type',
                    subject: 'subject',
                    data: {
                        'user-agent': '?/?',
                        'x-request-id': operationId,
                        'x-on-behalf-of-user-id': 'user-1',
                        'x-on-behalf-of-org': 'org-1',
                    },
                    messageId: undefined,
                    extras: {
                        attributes: undefined,
                        attribution: { onBehalfOf: { userId: 'user-1', org: 'org-1' } },
                    },
                },
            ])
        })
    })
})

function withoutUndefined(obj: { readonly [key: string]: unknown }) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
}

async function executeHandler(
    handler: Handler,
    headers?: { [key: string]: string },
    env: { [key: string]: string } = {},
) {
    const logTransport = new TestTransport()
    const eventTransport = new TestEventTransport()
    const { log, context, success, flush } = createContext(
        clientFromHeaders(headers),
        [logTransport],
        eventTransport,
        { default: 10 },
        new AbortController(),
        undefined,
        undefined,
        env,
    )

    const response = await executeRequest(
        log,
        context,
        {
            meta: undefined,
            config: undefined,
            method: 'GET',
            pathPattern: '/',
            entry: handler,
        },
        {
            uri: '',
            headers,
        },
        success,
    )
    await flush()
    delete (response as any).logBody
    return {
        response,
        operationId: context.operationId,
        entries: logTransport.entries,
        events: eventTransport.sent,
    }
}

class TestTransport implements LogTransport {
    readonly entries: LogEntry[] = []

    sendEntries(entries: LogEntry[]) {
        this.entries.push(...entries)
    }
}

class TestEventTransport implements EventTransport {
    readonly sent: {
        topic: string
        type: string
        subject: string
        data: JsonSafeObject | undefined
        messageId: string | undefined
        extras: { attributes?: EventAttributes; attribution?: Attribution } | undefined
    }[] = []

    sendEvent(
        topic: string,
        type: string,
        subject: string,
        data: JsonSafeObject | undefined,
        messageId: string | undefined,
        _signal: AbortSignal,
        extras?: { attributes?: EventAttributes; attribution?: Attribution },
    ) {
        this.sent.push({ topic, type, subject, data, messageId, extras })
        return Promise.resolve()
    }
}
