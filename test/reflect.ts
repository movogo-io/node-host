import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { reflect } from '../host/reflect.js'

const plain = 'test/data/reflect-plain'
const filtered = 'test/data/reflect-filtered'
const linked = 'test/data/reflect-linked'
const upstream = 'test/data/reflect-upstream'
const decoy = 'test/data/node_modules/@movogo-io/host'

describe('reflection', () => {
    before(async () => {
        await Promise.all([
            installHost(plain),
            installHost(filtered),
            installHost(linked),
            installContractStub(join(filtered, 'node_modules/@movogo-io/contract')),
            installLinkedContractStub(linked),
            installUpstreamHost(upstream),
            copyHost(decoy),
        ])
    })

    it('includes revision', async () => {
        const { revision, ...reflection } = await reflect(process.cwd())

        assert.ok((revision?.length === 8 && revision.endsWith('+')) || revision?.length === 7)
        assert.deepStrictEqual(reflection, {
            name: '@movogo-io/host',
            events: [],
            http: [],
            timers: [],
            emits: [],
        })
    })

    it('reflects a service without the contract package as declaring no emits', async () => {
        const { revision: _revision, ...reflection } = await reflect(plain)

        assert.deepStrictEqual(reflection, {
            name: 'reflect-plain',
            events: [
                {
                    name: 'hello',
                    topic: 'status',
                    type: 'greeting',
                    config: { cpus: undefined, os: undefined, nodeVersion: '>=24' },
                },
            ],
            http: [],
            timers: [],
            emits: [],
        })
    })

    it('reflects the filter of a handler and the emits the contract package declares', async () => {
        const { revision: _revision, ...reflection } = await reflect(filtered)

        assert.deepStrictEqual(reflection, {
            name: 'reflect-filtered',
            events: [
                {
                    name: 'follow',
                    topic: 'document',
                    type: 'changed',
                    config: {
                        filter: { resource: ['rental'] },
                        cpus: undefined,
                        os: undefined,
                        nodeVersion: '>=24',
                    },
                },
            ],
            http: [],
            timers: [],
            emits: [
                { topic: 'document', type: 'changed' },
                { topic: 'rental', type: 'completed', prefixEnv: 'EMIT_TOPIC_PREFIX' },
            ],
        })
    })

    it('reflects through the host the service package resolves, not one further up the tree', async () => {
        const { revision: _revision, ...reflection } = await reflect(upstream)

        assert.deepStrictEqual(reflection, {
            name: 'reflect-upstream',
            events: [
                {
                    name: 'hello',
                    topic: 'status',
                    type: 'greeting',
                    config: { cpus: undefined, os: undefined, nodeVersion: '>=24' },
                },
            ],
            http: [],
            timers: [],
            emits: [],
        })
    })

    it('reads the emits through a linked contract package', async () => {
        const { revision: _revision, ...reflection } = await reflect(linked)

        assert.deepStrictEqual(reflection, {
            name: 'reflect-linked',
            events: [
                {
                    name: 'follow',
                    topic: 'document',
                    type: 'changed',
                    config: {
                        filter: { resource: ['rental'] },
                        cpus: undefined,
                        os: undefined,
                        nodeVersion: '>=24',
                    },
                },
            ],
            http: [],
            timers: [],
            emits: [
                { topic: 'document', type: 'changed' },
                { topic: 'rental', type: 'completed', prefixEnv: 'EMIT_TOPIC_PREFIX' },
            ],
        })
    })
})

// The generated .gitignore drops every .js and node_modules/, so a fixture commits only its
// .ts entry files (plain JavaScript, listed by reflect) and this derives the rest: the .js
// twin reflect imports, and a copy of the built host so the fixture resolves @movogo-io/host
// to a registry instance of its own (a symlink would share the root registry across fixtures).
async function installHost(fixture: string) {
    await Promise.all([
        compileEntries(fixture),
        copyHost(join(fixture, 'node_modules/@movogo-io/host')),
    ])
}

async function compileEntries(fixture: string) {
    const entries = (await readdir(fixture)).filter(f => extname(f) === '.ts')
    await Promise.all(
        entries.map(f => copyFile(join(fixture, f), join(fixture, basename(f, '.ts') + '.js'))),
    )
}

async function copyHost(target: string) {
    await mkdir(target, { recursive: true })
    await Promise.all([
        ...['package.json', 'event.js', 'context.js'].map(f => copyFile(f, join(target, f))),
        cp('host', join(target, 'host'), { recursive: true, filter: f => !f.endsWith('.ts') }),
    ])
}

// A service still on the upstream names: its entry files import `@riddance/service/event`, a
// stub that re-exports the `@riddance/host` beside it, so its handlers register there. The decoy
// `@movogo-io/host` two directories up is what a walk from the fixture finds first.
async function installUpstreamHost(fixture: string) {
    const service = join(fixture, 'node_modules/@riddance/service')
    await Promise.all([
        compileEntries(fixture),
        copyHost(join(fixture, 'node_modules/@riddance/host')),
        mkdir(service, { recursive: true }),
    ])
    await Promise.all([
        writeFile(
            join(service, 'package.json'),
            JSON.stringify({
                name: '@riddance/service',
                type: 'module',
                exports: { './event': './event.js' },
            }),
        ),
        writeFile(join(service, 'event.js'), "export * from '@riddance/host/lib/event'\n"),
    ])
}

async function installContractStub(target: string) {
    await mkdir(target, { recursive: true })
    await Promise.all([
        writeFile(
            join(target, 'package.json'),
            JSON.stringify({
                name: '@movogo-io/contract',
                type: 'module',
                exports: { './schema': './schema.js' },
            }),
        ),
        // The stub keeps module state and the fixture's entry file declares into it, so the
        // test fails if reflect imports a second instance of schema.js instead of the one the
        // entry files populated (it would then see an empty list).
        writeFile(
            join(target, 'schema.js'),
            [
                'const emits = []',
                'export const declareEmit = emit => emits.push(emit)',
                'export const declaredEmits = () => [...emits]',
                '',
            ].join('\n'),
        ),
    ])
}

// A `file:` or `npm link` install puts a symlink in node_modules, as this run's own fork-to-fork
// dependencies do. The stub lives under another project's node_modules, outside the fixture's
// resolution path, so it is reached only through the link.
async function installLinkedContractStub(fixture: string) {
    const real = join(fixture, 'linked/node_modules/@movogo-io/contract')
    const link = join(fixture, 'node_modules/@movogo-io/contract')
    await Promise.all([installContractStub(real), mkdir(dirname(link), { recursive: true })])
    await rm(link, { recursive: true, force: true })
    await symlink(relative(dirname(link), real), link, 'dir')
}
