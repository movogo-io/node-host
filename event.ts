import { Context, HandlerConfiguration, type JsonObject } from './context.js'
import { registerEventHandler } from './host/event-registry.js'

export * from './context.js'

export type EventHandlerConfiguration = HandlerConfiguration & {}

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
export function on(topic: string, event: string, config: HandlerConfiguration, fn: Handler): void
export function on(
    topic: string,
    event: string,
    configOrHandler: HandlerConfiguration | Handler,
    fn?: Handler,
): void {
    registerEventHandler(topic, event, configOrHandler, fn)
}
