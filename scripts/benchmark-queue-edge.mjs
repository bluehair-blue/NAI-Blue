import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const execFileAsync = promisify(execFile)
const outputPath = process.argv[2] ?? 'docs/releases/evidence/queue-edge-benchmark.json'
const cdpUrl = process.env.QUEUE_BENCHMARK_CDP_URL
const timestamp = new Date().toISOString()
const [{ stdout: commit }, { stdout: tree }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD']),
    execFileAsync('git', ['rev-parse', 'HEAD^{tree}']),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all']),
])
if (status.trim().length > 0) {
    throw new Error('Queue edge benchmark requires a clean Git checkout')
}
let server
let browser
let ownsBrowser = false
let report

try {
    server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
    await server.listen()
    const address = server.httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('Vite did not expose a TCP port')

    browser = cdpUrl
        ? await chromium.connectOverCDP(cdpUrl)
        : await chromium.launch({ channel: 'msedge', headless: true })
    ownsBrowser = !cdpUrl
    const page = cdpUrl
        ? browser.contexts()[0]?.pages()[0]
        : await browser.newPage()
    if (page === undefined) throw new Error('Attached WebView2 host has no reusable page')
    await page.goto(`http://127.0.0.1:${address.port}/scripts/benchmark-queue-edge.html`)
    const measured = await page.evaluate(() => window.queueBenchmark)
    report = {
        schemaVersion: 1,
        benchmark: 'phase-6-atomic-queue-enqueue-reopen',
        evidenceScope: cdpUrl
            ? 'Windows embedded WebView2 IndexedDB; not Android'
            : 'Windows Microsoft Edge IndexedDB; not embedded WebView2 or Android',
        durationSemantics: {
            transactionDurationMs: 'createBatchAndEnqueue, including repository readback verification',
            reopenReadDurationMs: 'new repository startup recovery plus batch, job, reservation, and claim reads',
        },
        timestamp,
        source: {
            commit: commit.trim(),
            tree: tree.trim(),
            clean: true,
        },
        runtime: { platform: process.platform, node: process.version },
        browser: {
            channel: cdpUrl ? 'embedded-webview2-cdp' : 'msedge',
            version: browser.version(),
            userAgent: await page.evaluate(() => navigator.userAgent),
        },
        sampleSizes: measured.samples.map(({ jobs, claimsPerJob, totalClaims }) => ({
            jobs, claimsPerJob, totalClaims,
        })),
        supportedMeasuredMaximum: measured.samples
            .filter(sample => sample.pass)
            .map(({ jobs, claimsPerJob, totalClaims }) => ({ jobs, claimsPerJob, totalClaims }))
            .at(-1) ?? null,
        samples: measured.samples,
        pass: measured.pass,
    }
} catch (error) {
    report = {
        schemaVersion: 1,
        benchmark: 'phase-6-atomic-queue-enqueue-reopen',
        evidenceScope: cdpUrl
            ? 'Windows embedded WebView2 IndexedDB; not Android'
            : 'Windows Microsoft Edge IndexedDB; not embedded WebView2 or Android',
        timestamp,
        runtime: { platform: process.platform, node: process.version },
        source: {
            commit: commit.trim(),
            tree: tree.trim(),
            clean: true,
        },
        error: {
            name: error instanceof Error ? error.name : 'UnknownError',
            message: error instanceof Error
                ? error.message.replace(/[A-Za-z]:[\\/][^\s"']+/g, '<local-path>')
                : 'Unknown benchmark failure',
        },
        pass: false,
    }
} finally {
    if (ownsBrowser) await browser?.close()
    await server?.close()
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1
// Dropping this process disconnects CDP without sending Browser.close to the user-owned WebView2 host.
if (cdpUrl) process.exit(report.pass ? 0 : 1)
