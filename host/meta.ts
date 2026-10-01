import type { HandlerConfiguration } from '../context.js'

export type PackageConfiguration = HandlerConfiguration & {
    // Placeholder for package-level configurations
}

// eslint-disable-next-line @typescript-eslint/no-duplicate-type-constituents
export type FullConfiguration = PackageConfiguration & HandlerConfiguration

export function combineConfig(
    base: PackageConfiguration | undefined,
    override: HandlerConfiguration | undefined,
): FullConfiguration | undefined {
    if (base === undefined) {
        return override
    }
    // A filter belongs to one handler's subscription. The shallow spread below would hand a
    // package-level filter to every event handler that sets none, silently narrowing them all.
    const { filter: _packageFilter, ...packageConfig } = base
    if (override === undefined) {
        return packageConfig
    }
    return { ...packageConfig, ...override }
}

let metadata: Metadata | undefined

export function setMeta(
    packageName: string,
    fileName: string,
    revision: string | undefined,
    config: PackageConfiguration | undefined,
) {
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function
    metadata = {
        packageName,
        fileName,
        revision,
        config,
    }
}

export type Metadata = {
    packageName: string
    fileName: string
    revision: string | undefined
    config?: PackageConfiguration
}

export function getMetadata() {
    return metadata
}
