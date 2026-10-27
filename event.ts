import { Context, HandlerConfiguration, type JsonObject } from './context.js'
import { registerEventHandler } from './host/event-registry.js'

export * from './context.js'

export type EventHandlerConfiguration = HandlerConfiguration & {
    /**
    The most invocations of this handler running at once. Deliveries past it wait in the
    platform's own queue instead of failing, so a burst of events cannot exhaust the concurrency
    the handler's account shares with every other function. A stage's glue may override it.
    */
    readonly concurrencyMax?: number
}

export type Handler = (
    context: Context,
    subject: string,
    event: JsonObject | undefined,
    timestamp: Date,
    messageId: string,
) => Promise<void> | void

/**
Registers the handler for events of `topic` and `event`.

With `config.filter`, only events whose attributes carry every named attribute with a value
strictly equal to one of the listed exact values are delivered. Filters for announcements
come from the contract package's helpers, never spelled by hand.
*/
export function on(topic: string, event: string, fn: Handler): void
export function on(
    topic: string,
    event: string,
    config: EventHandlerConfiguration,
    fn: Handler,
): void
export function on(
    topic: string,
    event: string,
    configOrHandler: EventHandlerConfiguration | Handler,
    fn?: Handler,
): void {
    registerEventHandler(topic, event, configOrHandler, fn)
}
