import { readdir, readFile } from 'node:fs/promises'
import { createRequire, findPackageJSON } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HandlerConfiguration } from '../context.js'
import type { HttpHandlerConfiguration } from '../http.js'
import type { TimerHandlerConfiguration } from '../timer.js'
import { getHash } from './git.js'
import type { PackageConfiguration } from './meta.js'
import type { HandlersGetter } from './registry.js'

type CPU =
    | 'arm'
    | 'arm64'
    | 'ia32'
    | 'mips'
    | 'mipsel'
    | 'ppc'
    | 'ppc64'
    | 's390'
    | 's390x'
    | 'x32'
    | 'x64'
type CpuConfig = CPU | `!${CPU}`
type OSConfig = NodeJS.Platform | `!${NodeJS.Platform}`

export type PackageJsonConfiguration = {
    nodeVersion?: string
    cpus?: CpuConfig[]
    os?: OSConfig[]
}

export type Reflection = {
    name: string
    revision: string | undefined
    http: {
        name: string
        method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE'
        pathPattern: string
        config: HttpHandlerConfiguration & PackageJsonConfiguration
    }[]
    timers: {
        name: string
        schedule: string
        config: TimerHandlerConfiguration & PackageJsonConfiguration
    }[]
    events: {
        name: string
        topic: string
        type: string
        config: HandlerConfiguration & PackageJsonConfiguration
    }[]
    /**
    What the service declares it emits (the contract package's `declareEmit`), for the deploy
    to create and grant. `prefixEnv` names the environment variable whose value prefixes the topic.
    */
    emits: {
        topic: string
        type: string
        prefixEnv?: string
    }[]
}

export function resolveCpu(config: PackageJsonConfiguration, supported: CPU[]): CPU {
    const resolved = resolveSupported(config.cpus, supported)
    if (!resolved) {
        // resolveSupported<T>(config, supported) actually asserts config is (T | `!${T}`)[], but that's not supported yet.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        throw new Error('Unsupported CPUs: ' + config.cpus!.join(', '))
    }
    return resolved
}

export function resolveOS(
    config: PackageJsonConfiguration,
    supported: NodeJS.Platform[],
): NodeJS.Platform {
    const resolved = resolveSupported(config.os, supported)
    if (!resolved) {
        // resolveSupported<T>(config, supported) actually asserts config is (T | `!${T}`)[], but that's not supported yet.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        throw new Error('Unsupported operating systems: ' + config.os!.join(', '))
    }
    return resolved
}

function resolveSupported<T extends string>(config: (T | `!${T}`)[] | undefined, supported: T[]) {
    if (!config) {
        return supported[0]
    }
    return supported.find(s => config.includes(s) && !config.includes(`!${s}`))
}

export async function reflect(path: string): Promise<Reflection> {
    const absolutePath = resolve(process.cwd(), path)
    const [packageJson, allFiles, revision] = await Promise.all([
        readConfig(absolutePath),
        readdir(absolutePath),
        getHash(absolutePath),
    ])
    const files = allFiles.filter(file => extname(file) === '.ts' && !file.endsWith('.d.ts'))
    const serviceUrl = `${pathToFileURL(absolutePath).href}/`
    // A service still on the upstream host must reflect under the forked deploy, so the fork
    // falls back to the upstream package until the fleet-wide pin has landed everywhere.
    const myPackageJson =
        packageJson.name === '@movogo-io/host'
            ? join(absolutePath, 'package.json')
            : (findInstalledPackageJSON('@movogo-io/host', serviceUrl) ??
              findInstalledPackageJSON('@riddance/host', serviceUrl))
    if (!myPackageJson) {
        throw new Error('Packages not installed')
    }
    const { getHandlers, setMeta } = (await import(
        pathToFileURL(join(dirname(myPackageJson), 'host/registry.js')).toString()
    )) as {
        getHandlers: HandlersGetter
        setMeta: (
            packageName: string,
            fileName: string,
            rev: string | undefined,
            cfg: PackageConfiguration | undefined,
        ) => void
    }

    for (const file of files) {
        const base = basename(file, '.ts')
        setMeta(packageJson.name, base, revision, packageJson.config)
        await import(pathToFileURL(join(absolutePath, base + '.js')).toString())
    }
    // After the entry files: only declarations their import graph reached are registered.
    const emits = await reflectEmits(serviceUrl)

    return {
        name: packageJson.name,
        revision,
        http: getHandlers('http').map(h => ({
            config: {
                ...h.config,
                cpus: packageJson.cpu,
                os: packageJson.os,
                nodeVersion: packageJson.engines?.node,
            },
            name: h.meta?.fileName ?? '',
            method: h.method,
            pathPattern: h.pathPattern,
        })),
        timers: getHandlers('timer').map(h => ({
            config: {
                ...h.config,
                cpus: packageJson.cpu,
                os: packageJson.os,
                nodeVersion: packageJson.engines?.node,
            },
            name: h.meta?.fileName ?? '',
            schedule: h.schedule,
        })),
        events: getHandlers('event').map(h => ({
            config: {
                ...h.config,
                cpus: packageJson.cpu,
                os: packageJson.os,
                nodeVersion: packageJson.engines?.node,
            },
            name: h.meta?.fileName ?? '',
            topic: h.topic,
            type: h.type,
        })),
        emits,
    }
}

type DeclaredEmit = { topic: string; event: string; prefixEnv?: string }

/**
Reads the emits the service's contract package declares. The contract package has no runtime
import of the host, so the host reads it instead, resolving `@movogo-io/contract/schema` from the
service directory the way the entry files' own import did: through the package's `exports` and
through any symlink of a `file:` or linked install to the real path, so the module instance is the
one they populated. A service without the contract package, or with one that predates
`declaredEmits`, declares nothing; a contract package that is installed but does not resolve the
export is a broken install, and the resolver's error says which path or export is missing.
*/
async function reflectEmits(serviceUrl: string): Promise<Reflection['emits']> {
    if (!findInstalledPackageJSON('@movogo-io/contract', serviceUrl)) {
        return []
    }
    // The CommonJS resolver, since import.meta.resolve takes no parent URL without a flag. Its
    // conditions differ from the ESM loader's only for a package that exports `import` and
    // `require` targets apart, which the contract package never does: every export of
    // node-platform is `{ types, default }`.
    const schemaPath = createRequire(serviceUrl).resolve('@movogo-io/contract/schema')
    const schema = (await import(pathToFileURL(schemaPath).toString())) as {
        declaredEmits?: () => DeclaredEmit[]
    }
    if (typeof schema.declaredEmits !== 'function') {
        return []
    }
    return schema
        .declaredEmits()
        .map(({ topic, event, prefixEnv }) =>
            prefixEnv === undefined ? { topic, type: event } : { topic, type: event, prefixEnv },
        )
}

async function readConfig(path: string) {
    const packageJson = JSON.parse(await readFile(join(path, 'package.json'), 'utf-8')) as {
        name: string
        engines?: { [engine: string]: string }
        cpu?: CpuConfig[]
        os?: OSConfig[]
        config?: object
    }
    return packageJson
}

// findPackageJSON throws ERR_MODULE_NOT_FOUND for a bare specifier that is not installed,
// rather than returning undefined as it does for an unresolvable path.
function findInstalledPackageJSON(packageName: string, base: string) {
    try {
        return findPackageJSON(packageName, base)
    } catch (e) {
        if ((e as { code?: unknown } | undefined)?.code === 'ERR_MODULE_NOT_FOUND') {
            return undefined
        }
        throw e
    }
}
