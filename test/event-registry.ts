import assert from 'node:assert/strict'
import { on } from '../event.js'
import { getHandlers, setMeta } from '../host/registry.js'
import { get } from '../http.js'
import { setInterval } from '../timer.js'

describe('event handler filters', () => {
    it('refuses a filter naming more than five attributes', () => {
        assert.throws(() => {
            on(
                'document',
                'changed',
                {
                    filter: {
                        a: ['x'],
                        b: ['x'],
                        c: ['x'],
                        d: ['x'],
                        e: ['x'],
                        f: ['x'],
                    },
                },
                () => undefined,
            )
        }, /names 6 attributes/u)
    })

    it('refuses a reserved key', () => {
        assert.throws(() => {
            on('document', 'changed', { filter: { operationId: ['x'] } }, () => undefined)
        }, /"operationId" is reserved/u)
    })

    it('refuses a key outside the attribute-name rule', () => {
        assert.throws(() => {
            on('document', 'changed', { filter: { Resource: ['rental'] } }, () => undefined)
        }, /"Resource" is invalid/u)
    })

    it('refuses a value needing escaping', () => {
        assert.throws(() => {
            on('document', 'changed', { filter: { resource: ['ren"tal'] } }, () => undefined)
        }, /"resource" lists an invalid value/u)
    })

    it('refuses a value listed twice', () => {
        assert.throws(() => {
            on(
                'document',
                'changed',
                { filter: { resource: ['rental', 'rental'] } },
                () => undefined,
            )
        }, /"resource" lists a value twice/u)
    })

    it('refuses more than 150 value combinations', () => {
        assert.throws(() => {
            on(
                'document',
                'changed',
                { filter: { resource: values(11), op: values(14) } },
                () => undefined,
            )
        }, /154 value combinations/u)
    })

    it('registers a handler with a valid filter, and nothing from the refused ones', () => {
        on('document', 'changed', { filter: { resource: ['rental'] } }, () => undefined)

        assert.deepStrictEqual(
            getHandlers('event').map(h => ({ topic: h.topic, type: h.type, config: h.config })),
            [
                {
                    topic: 'document',
                    type: 'changed',
                    config: { filter: { resource: ['rental'] } },
                },
            ],
        )
    })

    it('refuses a filter on an http handler', () => {
        assert.throws(() => {
            get('things', { filter: { resource: ['rental'] } }, () => undefined)
        }, /event handlers only, not to an http handler/u)
        assert.deepStrictEqual(getHandlers('http'), [])
    })

    it('refuses a filter on a timer handler', () => {
        assert.throws(() => {
            setInterval('* * * * *', { filter: { resource: ['rental'] } }, () => undefined)
        }, /event handlers only, not to a timer handler/u)
        assert.deepStrictEqual(getHandlers('timer'), [])
    })

    it('does not hand a package-level filter to a handler that sets none', () => {
        setMeta('some-service', 'follow', undefined, {
            filter: { resource: ['rental'] },
            timeout: 5,
        })
        on('rental', 'completed', () => undefined)

        const [, handler] = getHandlers('event')
        assert.deepStrictEqual(handler?.config, { timeout: 5 })
    })
})

function values(count: number): [string, ...string[]] {
    return ['v0', ...Array.from({ length: count - 1 }, (_, i) => `v${i + 1}`)]
}
