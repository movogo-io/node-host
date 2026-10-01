import type { EventAttributes, EventFilter } from '../context.js'

/**
The one point of truth for the rules on event attributes, subjects and handler filters.
Pure functions: the context's emit validates with them before calling the transport,
the event registry validates a handler's filter at registration, and the deploy
re-checks declared emits against them.
*/

export const eventAttributesMax = 4
export const eventAttributeValueLengthMax = 256
export const eventSubjectLengthMax = 100
export const eventFilterKeysMax = 5
export const eventFilterCombinationsMax = 150

/**
Attribute names an emitter may not use: the ones the host sets itself, SNS's own,
and the names of the attribution claim.
*/
export const reservedAttributeNames: readonly string[] = [
    'operationId',
    'clientId',
    'clientIp',
    'clientPort',
    'userAgent',
    'content-encoding',
    'onBehalfOfUserId',
    'onBehalfOfOrg',
]

const reservedAttributeNamesLowerCase = new Set(reservedAttributeNames.map(n => n.toLowerCase()))
const attributeNamePattern = /^[a-z][A-Za-z0-9]{0,63}$/u
const filterValuePattern = /^[A-Za-z0-9._:-]{1,256}$/u
const controlCharacterPattern = /\p{Cc}/u
const lineBreakOrControlCharacterPattern = /[\p{Cc}\p{Zl}\p{Zp}]/u

export function isReservedAttributeName(name: string) {
    const lowerCase = name.toLowerCase()
    return (
        reservedAttributeNamesLowerCase.has(lowerCase) ||
        lowerCase.startsWith('aws.') ||
        lowerCase.startsWith('amazon.')
    )
}

function validateAttributeName(name: string, what: string) {
    if (!attributeNamePattern.test(name)) {
        throw new Error(
            `Event ${what} name "${name}" is invalid; it must match ${attributeNamePattern.source}.`,
        )
    }
    if (isReservedAttributeName(name)) {
        throw new Error(`Event ${what} name "${name}" is reserved.`)
    }
}

/**
Throws a plain Error naming the offending attribute (never its value) when the
attributes an emitter supplied break the rules.
*/
export function validateEventAttributes(attributes: EventAttributes | undefined) {
    if (attributes === undefined) {
        return
    }
    const names = Object.keys(attributes)
    if (names.length > eventAttributesMax) {
        throw new Error(
            `Too many event attributes: ${names.length} given, at most ${eventAttributesMax} allowed.`,
        )
    }
    for (const name of names) {
        validateAttributeName(name, 'attribute')
        const value: unknown = attributes[name]
        if (typeof value !== 'string' || value.length === 0) {
            throw new Error(`Event attribute "${name}" must be a non-empty string.`)
        }
        if (value.length > eventAttributeValueLengthMax) {
            throw new Error(
                `Event attribute "${name}" is longer than ${eventAttributeValueLengthMax} characters.`,
            )
        }
        if (controlCharacterPattern.test(value)) {
            throw new Error(`Event attribute "${name}" contains a control character.`)
        }
    }
}

/**
Throws a plain Error naming "subject" (never the value) when the subject is one SNS refuses.
*/
export function validateEventSubject(subject: string) {
    if (typeof subject !== 'string' || subject.length === 0) {
        throw new Error('Event subject must be a non-empty string.')
    }
    if (subject.length >= eventSubjectLengthMax) {
        throw new Error(`Event subject must be shorter than ${eventSubjectLengthMax} characters.`)
    }
    if (lineBreakOrControlCharacterPattern.test(subject)) {
        throw new Error('Event subject contains a line break or control character.')
    }
}

/**
Throws a plain Error naming the offending key when a handler's filter breaks the rules
SNS puts on a filter policy (as narrowed by the filtering plan: exact strings only).
*/
export function validateEventFilter(filter: EventFilter) {
    const candidate: unknown = filter
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error('Event filter must be an object of attribute names to listed values.')
    }
    const keys = Object.keys(filter)
    if (keys.length === 0) {
        throw new Error('Event filter must name at least one attribute.')
    }
    if (keys.length > eventFilterKeysMax) {
        throw new Error(
            `Event filter names ${keys.length} attributes; at most ${eventFilterKeysMax} allowed.`,
        )
    }
    let combinations = 1
    for (const key of keys) {
        validateAttributeName(key, 'filter')
        const values: unknown = filter[key]
        if (!Array.isArray(values) || values.length === 0) {
            throw new Error(`Event filter "${key}" must list at least one value.`)
        }
        if (new Set(values).size !== values.length) {
            throw new Error(`Event filter "${key}" lists a value twice.`)
        }
        for (const value of values as unknown[]) {
            if (typeof value !== 'string' || !filterValuePattern.test(value)) {
                throw new Error(
                    `Event filter "${key}" lists an invalid value; each must match ${filterValuePattern.source}.`,
                )
            }
        }
        combinations *= values.length
    }
    if (combinations > eventFilterCombinationsMax) {
        throw new Error(
            `Event filter has ${combinations} value combinations; at most ${eventFilterCombinationsMax} allowed.`,
        )
    }
}

/**
The SNS rule: every attribute the filter names is present with a value strictly equal
to one of the listed values. No filter accepts everything.
*/
export function filterAccepts(
    filter: EventFilter | undefined,
    attributes: EventAttributes | undefined,
): boolean {
    if (filter === undefined) {
        return true
    }
    return Object.entries(filter).every(([key, values]) => {
        const value = attributes?.[key]
        return value !== undefined && values.includes(value)
    })
}
