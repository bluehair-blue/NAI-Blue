import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const execFileAsync = promisify(execFile)
const outputPath = process.argv[2] ?? 'output/queue-edge-benchmark.json'
const cdpUrl = process.env.QUEUE_BENCHMARK_CDP_URL
const timestamp = new Date().toISOString()
let server
let browser
let ownsBrowser = false
let report

try {
    const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'])
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
        commit: commit.trim(),
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
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        pass: false,
    }
} finally {
    if (ownsBrowser) await browser?.close()
    await server?.close()
}

await mkdir(new URL('../output/', import.meta.url), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1
// Dropping this process disconnects CDP without sending Browser.close to the user-owned WebView2 host.
if (cdpUrl) process.exit(report.pass ? 0 : 1)
