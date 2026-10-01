import assert from 'node:assert/strict'
import type { EventAttributes } from '../context.js'
import { filterAccepts, validateEventAttributes, validateEventSubject } from '../host/attributes.js'

describe('attributes', () => {
    describe('validateEventAttributes', () => {
        const refused: {
            case: string
            attributes: EventAttributes
            names: string
            value?: string
        }[] = [
            {
                case: 'five names',
                attributes: { a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' },
                names: 'Too many event attributes',
            },
            {
                case: 'a name not starting with a lower-case letter',
                attributes: { Resource: 'x' },
                names: 'Resource',
            },
            {
                case: 'the reserved name content-encoding',
                attributes: { 'content-encoding': 'gzip' },
                names: 'content-encoding',
            },
            {
                case: 'a name in the AWS. namespace',
                attributes: { 'aws.x': 'x' },
                names: 'aws.x',
            },
            {
                case: 'a name in the Amazon. namespace',
                attributes: { 'Amazon.Y': 'x' },
                names: 'Amazon.Y',
            },
            {
                case: 'the reserved name onBehalfOfOrg',
                attributes: { onBehalfOfOrg: 'x' },
                names: 'onBehalfOfOrg',
            },
            {
                case: 'a reserved name in another case',
                // spell-checker: ignore onbehalfoforg
                attributes: { onbehalfoforg: 'x' },
                names: 'onbehalfoforg',
            },
            {
                case: 'an empty value',
                attributes: { region: '' },
                names: 'region',
            },
            {
                case: 'a 257-character value',
                attributes: { region: 'v'.repeat(257) },
                names: 'region',
                value: 'v'.repeat(257),
            },
            {
                case: 'a value with a line break',
                attributes: { region: 'eu\nwest' },
                names: 'region',
                value: 'eu\nwest',
            },
        ]

        for (const { case: name, attributes, names, value } of refused) {
            it(`refuses ${name}, naming the attribute and never the value`, () => {
                assert.throws(
                    () => {
                        validateEventAttributes(attributes)
                    },
                    (error: unknown) => {
                        assert.ok(Error.isError(error))
                        assert.strictEqual(error.message.includes(names), true)
                        if (value !== undefined) {
                            assert.strictEqual(error.message.includes(value), false)
                        }
                        return true
                    },
                )
            })
        }

        it('accepts undefined, no attributes and four valid attributes', () => {
            validateEventAttributes(undefined)
            validateEventAttributes({})
            validateEventAttributes({
                resource: 'rental',
                region: 'eu-west-1',
                supplierId: 'v'.repeat(256),
                k0: 'x',
            })
        })
    })

    describe('validateEventSubject', () => {
        const refused: { case: string; subject: string }[] = [
            { case: 'an empty subject', subject: '' },
            { case: 'a 100-character subject', subject: 's'.repeat(100) },
            { case: 'a subject with a line break', subject: 'first\nsecond' },
            { case: 'a subject with a control character', subject: 'bell\u{7}' },
        ]

        for (const { case: name, subject } of refused) {
            it(`refuses ${name}, naming the subject and never its value`, () => {
                assert.throws(
                    () => {
                        validateEventSubject(subject)
                    },
                    (error: unknown) => {
                        assert.ok(Error.isError(error))
                        assert.strictEqual(error.message.includes('subject'), true)
                        if (subject !== '') {
                            assert.strictEqual(error.message.includes(subject), false)
                        }
                        return true
                    },
                )
            })
        }

        it('accepts a 99-character subject', () => {
            validateEventSubject('s'.repeat(99))
        })
    })

    describe('filterAccepts', () => {
        it('accepts attributes matching every key', () => {
            assert.strictEqual(
                filterAccepts(
                    { resource: ['rental', 'quote'], region: ['eu'] },
                    { resource: 'quote', region: 'eu', extra: 'ignored' },
                ),
                true,
            )
        })

        it('refuses attributes missing a key', () => {
            assert.strictEqual(
                filterAccepts({ resource: ['rental'], region: ['eu'] }, { resource: 'rental' }),
                false,
            )
        })

        it('refuses a value not listed', () => {
            assert.strictEqual(
                filterAccepts({ resource: ['rental', 'quote'] }, { resource: 'Rental' }),
                false,
            )
        })

        it('accepts everything without a filter', () => {
            assert.strictEqual(filterAccepts(undefined, undefined), true)
            assert.strictEqual(filterAccepts(undefined, { resource: 'rental' }), true)
        })

        it('refuses an event without attributes when there is a filter', () => {
            assert.strictEqual(filterAccepts({ resource: ['rental'] }, undefined), false)
            assert.strictEqual(filterAccepts({ resource: ['rental'] }, {}), false)
        })
    })
})
