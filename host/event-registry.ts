import { type EventHandlerConfiguration, type Handler as EventFunction } from '../event.js'
import { validateEventFilter } from './attributes.js'
import { combineConfig, getMetadata, type FullConfiguration, type Metadata } from './meta.js'
import { addHandler } from './registry.js'

export type EventHandler = {
    meta: Metadata | undefined
    config: (FullConfiguration & EventHandlerConfiguration) | undefined
    topic: string
    type: string
    entry: EventFunction
}

type EventHost = (
    meta: Metadata | undefined,
    config: EventHandlerConfiguration | undefined,
    topic: string,
    type: string,
    handler: EventFunction,
) => void

let eventHostRegistry: EventHost

function setEventHost(host: EventHost) {
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function
    eventHostRegistry = host
}

function eventHost(
    meta: Metadata | undefined,
    cfg: EventHandlerConfiguration | undefined,
    topic: string,
    type: string,
    entry: EventFunction,
) {
    // A bad filter fails here, at import time in tests and at reflection in the deploy,
    // never as a subscription SNS refuses after the function is already live.
    if (cfg?.filter !== undefined) {
        validateEventFilter(cfg.filter)
    }
    if (
        cfg?.concurrencyMax !== undefined &&
        (!Number.isSafeInteger(cfg.concurrencyMax) || cfg.concurrencyMax < 1)
    ) {
        throw new Error(
            `concurrencyMax must be a positive integer, not ${String(cfg.concurrencyMax)}.`,
        )
    }
    addHandler('event', {
        meta,
        config: combineConfig(meta?.config, cfg),
        topic,
        type,
        entry,
    })
}

// eslint-disable-next-line unicorn/no-top-level-side-effects
setEventHost(eventHost)

export function registerEventHandler(
    topic: string,
    type: string,
    configOrHandler: EventHandlerConfiguration | EventFunction,
    fn?: EventFunction,
): void {
    if (typeof configOrHandler === 'function') {
        eventHostRegistry(getMetadata(), undefined, topic, type, configOrHandler)
    } else {
        if (!fn) {
            throw new Error('Please provide a handler function.')
        }
        eventHostRegistry(getMetadata(), configOrHandler, topic, type, fn)
    }
}
