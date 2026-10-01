import { declareEmit } from '@movogo-io/contract/schema'
import { on } from '@movogo-io/host/lib/event'

declareEmit({ topic: 'document', event: 'changed' })
declareEmit({ topic: 'rental', event: 'completed', prefixEnv: 'EMIT_TOPIC_PREFIX' })

on('document', 'changed', { filter: { resource: ['rental'] } }, () => undefined)
