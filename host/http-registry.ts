import { type HandlerConfiguration, type Handler as HttpFunction } from '../http.js'
import { combineConfig, getMetadata, type FullConfiguration, type Metadata } from './meta.js'
import { addHandler } from './registry.js'

export type HttpHandler = {
    meta: Metadata | undefined
    config: FullConfiguration | undefined
    method: Method
    pathPattern: string
    entry: HttpFunction
}

type HttpHost = (
    meta: Metadata | undefined,
    config: HandlerConfiguration | undefined,
    method: Method,
    path: string,
    handler: HttpFunction,
) => void

let httpHostRegistry: HttpHost

function setHttpHost(host: HttpHost) {
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function
    httpHostRegistry = host
}

export function pathToRegExp(path: string) {
    return new RegExp(
        (
            '^' +
            path.replaceAll(/[/\\^$+?.()|[\]{}]/gu, '\\$&').replaceAll('*', '[^/\\?]+') +
            '(\\?.*)?$'
        ).replace('[^/\\?]+[^/\\?]+(\\?.*)?$', ''),
        'u',
    )
}

function httpHost(
    meta: Metadata | undefined,
    cfg: HandlerConfiguration | undefined,
    method: Method,
    path: string,
    entry: HttpFunction,
) {
    if (cfg?.filter !== undefined) {
        throw new Error('A filter applies to event handlers only, not to an http handler.')
    }
    addHandler('http', {
        meta,
        config: combineConfig(meta?.config, cfg),
        method,
        pathPattern: path,
        entry,
    })
}

// eslint-disable-next-line unicorn/no-top-level-side-effects
setHttpHost(httpHost)

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export function registerHttpHandler(
    method: Method,
    path: string,
    configOrHandler: HandlerConfiguration | HttpFunction,
    fn?: HttpFunction,
): void {
    if (path.startsWith('/')) {
        throw new Error('Path cannot start with slash.')
    }
    if (typeof configOrHandler === 'function') {
        httpHostRegistry(getMetadata(), undefined, method, path, configOrHandler)
    } else {
        if (!fn) {
            throw new Error('Please provide a handler function.')
        }
        httpHostRegistry(getMetadata(), configOrHandler, method, path, fn)
    }
}
