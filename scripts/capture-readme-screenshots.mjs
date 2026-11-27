import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Regenerates the README screenshots in docs/images/ (three screens for each README language).
// Every run starts from an empty browser profile and types the demo text below, so no account,
// prompt, or generated image from a real workspace can end up in the repository.
// Starts its own Vite server unless README_SHOTS_URL points at one that is already running.
const port = Number(process.env.README_SHOTS_PORT || 5183)
const baseUrl = process.env.README_SHOTS_URL || `http://127.0.0.1:${port}`
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const outputDir = fileURLToPath(new URL('../docs/images/', import.meta.url))
const viewport = { width: 1280, height: 800 }

// Tag-style prompt for the Single screen; the same text reads naturally in every UI language.
const SINGLE_PROMPT = '1girl, blue hair, long hair, reading, book, window, morning light, soft lighting'

// A named folder holds the demo because the built-in folder keeps its stored Korean name in every UI language.
// items are [description, name, copies] rows typed into the Make images composer.
const DEMO = {
    en: {
        locale: 'en-US',
        folder: 'Illustrations',
        items: [
            ['A blue-haired girl reading by the window, soft morning light', 'Girl by the window', 4],
            ['A lighthouse on a cliff at dusk, watercolor style', 'Cliff lighthouse', 2],
            ['A cozy cat cafe interior with warm lamps', 'Cat cafe', 3],
        ],
    },
    ko: {
        locale: 'ko-KR',
        folder: '삽화',
        items: [
            ['창가에 앉아 책을 읽는 파란 머리 소녀, 부드러운 아침 햇살', '창가의 소녀', 4],
            ['해 질 녘 절벽 위의 등대, 수채화풍', '절벽 위 등대', 2],
            ['따뜻한 조명이 켜진 고양이 카페 실내', '고양이 카페', 3],
        ],
    },
    ja: {
        locale: 'ja-JP',
        folder: 'イラスト',
        items: [
            ['窓辺で本を読む青い髪の少女、やわらかな朝の光', '窓辺の少女', 4],
            ['夕暮れの崖に立つ灯台、水彩風', '崖の灯台', 2],
            ['暖かい照明の猫カフェの店内', '猫カフェ', 3],
        ],
    },
}

function quoteWindowsArg(arg) {
    if (/^[A-Za-z0-9_:./=-]+$/.test(arg)) return arg
    return `"${arg.replace(/"/g, '\\"')}"`
}

function run(command, args) {
    const prepared = process.platform === 'win32'
        ? { command: 'cmd.exe', args: ['/d', '/s', '/c', [command, ...args.map(quoteWindowsArg)].join(' ')] }
        : { command, args }
    return spawn(prepared.command, prepared.args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

async function waitForReady(child) {
    let output = ''
    const started = Date.now()
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    while (Date.now() - started < 30_000) {
        if (output.toLowerCase().includes('ready in')) return
        await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`Vite dev server did not become ready.\n${output}`)
}

async function closeServer(child) {
    if (!child || child.exitCode !== null) return
    if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        return
    }
    child.kill()
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3_000))])
}

/** Looks up UI strings by key so the script follows label changes in src/i18n/locales. */
function loadStrings(language) {
    const strings = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${language}.json`, import.meta.url), 'utf8'))
    return key => {
        const value = key.split('.').reduce((node, part) => node?.[part], strings)
        if (typeof value !== 'string') throw new Error(`Missing ${language} string: ${key}`)
        return value
    }
}

async function save(page, name) {
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${outputDir}${name}.png` })
    console.log(`saved docs/images/${name}.png`)
}

async function captureLanguage(browser, language) {
    const demo = DEMO[language]
    const text = loadStrings(language)
    const context = await browser.newContext({ viewport, locale: demo.locale })
    await context.route('**/*', route => {
        const url = route.request().url()
        if (url.startsWith(baseUrl) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
        return route.abort()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
        await page.goto(`${baseUrl}/folders`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: text('folderWorkbench.design.newFolder') }).click()
        const folderDialog = page.locator('[role="dialog"]')
        await folderDialog.getByPlaceholder(text('generationFolders.manager.newName')).fill(demo.folder)
        await folderDialog.getByRole('button', { name: text('generationFolders.manager.createSeparate') }).click()
        await page.keyboard.press('Escape')
        await folderDialog.waitFor({ state: 'detached' })
        await page.locator(`aside button[title="${demo.folder}"]`).click()
        const descriptions = page.locator('main form textarea')
        await descriptions.first().waitFor({ state: 'visible' })
        for (const [index, [description, name, copies]] of demo.items.entries()) {
            if (index > 0) await page.getByRole('button', { name: text('folderWorkbench.composer.addPrompt') }).click()
            await descriptions.nth(index).fill(description)
            await page.getByLabel(text('folderWorkbench.composer.name'), { exact: true }).nth(index).fill(name)
            await page.getByLabel(text('folderWorkbench.composer.count'), { exact: true }).nth(index).fill(String(copies))
        }
        await page.getByRole('button', { name: text('folderWorkbench.composer.next') }).click()
        await page.getByText(demo.items[0][1], { exact: true }).first().waitFor({ state: 'visible' })
        // The browser build asks visitors to open the desktop app; the app itself never shows that line.
        await page.getByText(text('folderWorkbench.design.desktopHint')).first().evaluate(node => node.remove())
        await save(page, `${language}-make-images`)

        await page.goto(`${baseUrl}/advanced`, { waitUntil: 'domcontentloaded' })
        const editor = page.locator('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] textarea').first()
        await editor.waitFor({ state: 'visible' })
        await editor.fill(SINGLE_PROMPT)
        await save(page, `${language}-single`)

        // Library is the backdrop because its empty state is fully translated in all three languages.
        await page.goto(`${baseUrl}/library`, { waitUntil: 'domcontentloaded' })
        await page.locator('.fb-app-tools').click()
        await page.locator('[role="menu"]').first().waitFor({ state: 'visible' })
        await save(page, `${language}-tools`)
    } finally {
        await context.close()
    }
}

async function main() {
    mkdirSync(outputDir, { recursive: true })
    const server = process.env.README_SHOTS_URL
        ? null
        : run(npmCommand, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'])
    try {
        if (server) await waitForReady(server)
        const browser = await chromium.launch()
        try {
            for (const language of Object.keys(DEMO)) await captureLanguage(browser, language)
        } finally {
            await browser.close()
        }
    } finally {
        await closeServer(server)
    }
}

await main()
