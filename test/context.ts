import assert from 'node:assert/strict'
import {
    httpRequestHeaders,
    type Attribution,
    type EventAttributes,
    type JsonSafeObject,
} from '../context.js'
import { claim } from '../host/attribution.js'
import {
    createContext,
    type EventTransport,
    type LogEntry,
    type LogTransport,
} from '../host/context.js'

describe('context', () => {
    describe('emit', () => {
        it('passes the attributes and the shared attribution holder to the transport', async () => {
            const events = new RecordingEventTransport()
            const { context, flush } = createContext(
                {},
                [new TestTransport()],
                events,
                { default: 15 },
                new AbortController(),
            )

            await context.emit('topic', 'type', 'subject', { a: 1 }, 'm-1', { region: 'eu' })
            await flush()

            assert.deepStrictEqual(events.sent, [
                {
                    topic: 'topic',
                    type: 'type',
                    subject: 'subject',
                    data: { a: 1 },
                    messageId: 'm-1',
                    extras: { attributes: { region: 'eu' }, attribution: {} },
                },
            ])
            assert.strictEqual(events.sent[0]?.extras.attribution, context.attribution)
        })

        it('passes undefined attributes when none are given', async () => {
            const events = new RecordingEventTransport()
            const { context, flush } = createContext(
                {},
                [new TestTransport()],
                events,
                { default: 15 },
                new AbortController(),
            )

            await context.emit('topic', 'type', 'subject')
            await flush()

            assert.deepStrictEqual(events.sent, [
                {
                    topic: 'topic',
                    type: 'type',
                    subject: 'subject',
                    data: undefined,
                    messageId: undefined,
                    extras: { attributes: undefined, attribution: {} },
                },
            ])
        })

        const refusedAttributes: { case: string; attributes: EventAttributes; names: string }[] = [
            {
                case: 'five attributes',
                attributes: { a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' },
                names: 'Too many event attributes',
            },
            {
                case: 'an attribute name not starting with a lower-case letter',
                attributes: { Resource: 'x' },
                names: 'Resource',
            },
            {
                case: 'an attribute name longer than 64 characters',
                attributes: { ['a'.repeat(65)]: 'x' },
                names: 'a'.repeat(65),
            },
            {
                case: 'the reserved attribute content-encoding',
                attributes: { 'content-encoding': 'gzip' },
                names: 'content-encoding',
            },
            {
                case: 'the reserved attribute operationId',
                attributes: { operationId: 'x' },
                names: 'operationId',
            },
            {
                case: 'an attribute in the AWS. namespace',
                attributes: { 'aws.x': 'x' },
                names: 'aws.x',
            },
            {
                case: 'an attribute in the Amazon. namespace',
                attributes: { 'Amazon.Y': 'x' },
                names: 'Amazon.Y',
            },
            {
                case: 'the reserved attribute onBehalfOfUserId',
                attributes: { onBehalfOfUserId: 'x' },
                names: 'onBehalfOfUserId',
            },
            {
                case: 'an empty attribute value',
                attributes: { region: '' },
                names: 'region',
            },
            {
                case: 'a 257-character attribute value',
                attributes: { region: 'v'.repeat(257) },
                names: 'region',
            },
            {
                case: 'an attribute value with a control character',
                attributes: { region: 'eu\u{7}' },
                names: 'region',
            },
        ]

        for (const { case: name, attributes, names } of refusedAttributes) {
            it(`refuses ${name} before calling the transport`, async () => {
                const events = new RecordingEventTransport()
                const { context, flush } = createContext(
                    {},
                    [new TestTransport()],
                    events,
                    { default: 15 },
                    new AbortController(),
                )

                await assert.rejects(
                    () => context.emit('topic', 'type', 'subject', {}, undefined, attributes),
                    (error: unknown) => {
                        assert.ok(Error.isError(error))
                        assert.strictEqual(error.message.includes(names), true)
                        return true
                    },
                )
                await flush()

                assert.deepStrictEqual(events.sent, [])
            })
        }

        const refusedSubjects: { case: string; subject: string }[] = [
            { case: 'an empty subject', subject: '' },
            { case: 'a 100-character subject', subject: 's'.repeat(100) },
            { case: 'a subject with a line break', subject: 'first\nsecond' },
            { case: 'a subject with a control character', subject: 'bell\u{7}' },
        ]

        for (const { case: name, subject } of refusedSubjects) {
            it(`refuses ${name} before calling the transport`, async () => {
                const events = new RecordingEventTransport()
                const { context, flush } = createContext(
                    {},
                    [new TestTransport()],
                    events,
                    { default: 15 },
                    new AbortController(),
                )

                await assert.rejects(
                    () => context.emit('topic', 'type', subject),
                    (error: unknown) => {
                        assert.ok(Error.isError(error))
                        assert.strictEqual(error.message.includes('subject'), true)
                        if (subject !== '') {
                            assert.strictEqual(error.message.includes(subject), false)
                        }
                        return true
                    },
                )
                await flush()

                assert.deepStrictEqual(events.sent, [])
            })
        }

        it('carries the attributes marker on the context and on a spread copy', async () => {
            const { context, flush } = createContext(
                {},
                [new TestTransport()],
                new RecordingEventTransport(),
                { default: 15 },
                new AbortController(),
            )
            await flush()

            assert.strictEqual(
                Reflect.get(context.emit, Symbol.for('movogo.emit.attributes')),
                true,
            )
            assert.strictEqual(
                Reflect.get({ ...context }.emit, Symbol.for('movogo.emit.attributes')),
                true,
            )
        })
    })

    describe('attribution', () => {
        it('shares one holder between the context, its spread copies and emitted events', async () => {
            const events = new RecordingEventTransport()
            const { context, flush } = createContext(
                { operationId: 'op-1' },
                [new TestTransport()],
                events,
                { default: 15 },
                new AbortController(),
            )

            const copy = { ...context }
            copy.attribution.onBehalfOf = claim('u1', 'o1')
            await context.emit('topic', 'type', 'subject')
            await flush()

            assert.deepStrictEqual(context.attribution, {
                onBehalfOf: { userId: 'u1', org: 'o1' },
            })
            assert.deepStrictEqual(events.sent, [
                {
                    topic: 'topic',
                    type: 'type',
                    subject: 'subject',
                    data: undefined,
                    messageId: undefined,
                    extras: {
                        attributes: undefined,
                        attribution: { onBehalfOf: { userId: 'u1', org: 'o1' } },
                    },
                },
            ])
            assert.strictEqual(events.sent[0]?.extras.attribution, context.attribution)
            assert.deepStrictEqual(httpRequestHeaders(context), {
                'user-agent': '?/?',
                'x-request-id': 'op-1',
                'x-on-behalf-of-user-id': 'u1',
                'x-on-behalf-of-org': 'o1',
            })
        })

        it('forwards a claim without an org as the user id header only', async () => {
            const { context, flush } = createContext(
                {},
                [new TestTransport()],
                new RecordingEventTransport(),
                { default: 15 },
                new AbortController(),
            )
            await flush()

            context.attribution.onBehalfOf = claim('u1')

            assert.deepStrictEqual(httpRequestHeaders(context), {
                'user-agent': '?/?',
                'x-on-behalf-of-user-id': 'u1',
            })
        })

        it('sends no on-behalf-of headers without a claim', async () => {
            const { context, flush } = createContext(
                { operationId: 'op-1' },
                [new TestTransport()],
                new RecordingEventTransport(),
                { default: 15 },
                new AbortController(),
            )
            await flush()

            assert.deepStrictEqual(context.attribution, {})
            assert.deepStrictEqual(httpRequestHeaders(context), {
                'user-agent': '?/?',
                'x-request-id': 'op-1',
            })
        })

        it('starts from the seeded attribution', async () => {
            const events = new RecordingEventTransport()
            const seed: Attribution = { onBehalfOf: claim('u2', 'o2') }
            const { context, flush } = createContext(
                {},
                [new TestTransport()],
                events,
                { default: 15 },
                new AbortController(),
                undefined,
                undefined,
                undefined,
                undefined,
                seed,
            )

            await context.emit('topic', 'type', 'subject')
            await flush()

            assert.strictEqual(context.attribution, seed)
            assert.deepStrictEqual(context.attribution, {
                onBehalfOf: { userId: 'u2', org: 'o2' },
            })
            assert.deepStrictEqual(
                events.sent.map(e => e.extras?.attribution),
                [{ onBehalfOf: { userId: 'u2', org: 'o2' } }],
            )
        })
    })

    describe('client', () => {
        it('keeps the client request id apart from the operation id', async () => {
            const { context, flush } = createContext(
                {
                    operationId: 'op-1',
                    clientId: 'client-1',
                    clientIp: '10.0.0.1',
                    clientPort: 4321,
                    userAgent: 'agent/1',
                    clientRequestId: 'req-9',
                },
                [new TestTransport()],
                new RecordingEventTransport(),
                { default: 15 },
                new AbortController(),
            )
            await flush()

            assert.strictEqual(context.operationId, 'op-1')
            assert.deepStrictEqual(context.client, {
                id: 'client-1',
                ip: '10.0.0.1',
                port: 4321,
                userAgent: 'agent/1',
                requestId: 'req-9',
            })
        })
    })
})

class RecordingEventTransport implements EventTransport {
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

class TestTransport implements LogTransport {
    readonly entries: LogEntry[] = []

    sendEntries(entries: LogEntry[]) {
        this.entries.push(...entries)
    }
}
