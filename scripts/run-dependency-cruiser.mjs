import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_NODE_MAJOR = 24
const PROJECT_NODE_MINIMUM_MINOR = 11

function supportsProjectRuntime(executable) {
    if (!existsSync(executable)) return false

    const probe = spawnSync(executable, ['--version'], {
        encoding: 'utf8',
        windowsHide: true,
    })
    const match = /^v(\d+)\.(\d+)\./.exec((probe.stdout ?? '').trim())

    return match !== null
        && Number(match[1]) === PROJECT_NODE_MAJOR
        && Number(match[2]) >= PROJECT_NODE_MINIMUM_MINOR
}

// npm can be started by an unsupported system Node while a project-compatible
// Node is also on PATH. Re-exec only Dependency Cruiser with that runtime so
// its support guard and this package's engines contract stay aligned.
const executableName = process.platform === 'win32' ? 'node.exe' : 'node'
const pathCandidates = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(directory => path.join(directory.replace(/^"|"$/g, ''), executableName))
const projectNode = [...new Set([process.execPath, ...pathCandidates])]
    .find(supportsProjectRuntime)

if (!projectNode) {
    console.error('Architecture checks require Node ^24.11.0. Activate Node 24 and retry.')
    process.exit(1)
}

// The CLI file was renamed within 18.x, so follow the package's own bin entry.
const dependencyCruiserRoot = new URL('../node_modules/dependency-cruiser/', import.meta.url)
const { bin } = JSON.parse(readFileSync(new URL('package.json', dependencyCruiserRoot), 'utf8'))
const dependencyCruiserCli = fileURLToPath(new URL(bin.depcruise, dependencyCruiserRoot))
const result = spawnSync(projectNode, [dependencyCruiserCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
