import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from 'playwright'

// Regression probes for the screen-audit findings that reviewers reproduced by hand
// (contrast, hit targets, empty-queue toolbar, scene counters, palette focus, inline edit keys).
// Starts its own Vite server unless QA_AUDIT_URL points at one that is already running.
const port = Number(process.env.QA_AUDIT_PORT || 5181)
const baseUrl = process.env.QA_AUDIT_URL || `http://127.0.0.1:${port}`
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const MIN_CONTRAST = 4.5
const MIN_TARGET = 44

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

/** Fresh context per check: empty IndexedDB/localStorage, Korean UI, network limited to the dev server. */
async function openPage(browser, viewport) {
    const context = await browser.newContext({ viewport, locale: 'ko-KR' })
    await context.route('**/*', route => {
        const url = route.request().url()
        if (url.startsWith(baseUrl) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
        return route.abort()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    return { context, page }
}

async function openAdvanced(page) {
    await page.goto(`${baseUrl}/advanced`, { waitUntil: 'domcontentloaded' })
    const editor = page.locator('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] textarea').first()
    await editor.waitFor({ state: 'visible' })
    return editor
}

/** Creates one scene from /scenes and lands on its detail route. */
async function createSceneDetail(page) {
    await page.goto(`${baseUrl}/scenes`, { waitUntil: 'domcontentloaded' })
    await page.locator('main button:has(svg.lucide-plus)').first().waitFor({ state: 'visible' })
    // "+" also marks queue and batch counters; "add scene" repeats its aria-label as visible text.
    await page.locator('main button:has(svg.lucide-plus)').evaluateAll(buttons => {
        for (const button of buttons) {
            const label = button.getAttribute('aria-label')
            const text = button.querySelector('span')?.textContent?.trim()
            if (button.dataset.testid === 'scene-empty-create' || (label && label === text)) button.setAttribute('data-qa-add-scene', '')
        }
    })
    await page.locator('[data-qa-add-scene]').first().click()
    await page.waitForURL(url => /^\/scenes\/[^/]+$/.test(url.pathname))
    await page.locator('[data-testid="scene-detail-workspace"]').waitFor({ state: 'visible' })
    return new URL(page.url()).pathname.split('/').pop()
}

async function blurActiveElement(page) {
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
}

/** In-app navigation through the numeric menu shortcut keeps the unsaved in-memory stores. */
async function navigateByMenuShortcut(page, digit, path) {
    await blurActiveElement(page)
    await page.keyboard.press(`Control+${digit}`)
    await page.waitForURL(url => url.pathname === path)
}

async function setTheme(page, theme) {
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
    if ((await isDark()) !== (theme === 'dark')) await page.locator('.fb-theme-toggle').first().click()
    await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, theme === 'dark')
    // Buttons animate color changes (180ms); measuring earlier reads the previous theme's fill.
    await page.waitForTimeout(400)
}

/** WCAG ratio of an element's text over its real backdrop (translucent layers blended up the ancestor chain). */
function contrastOf(element) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const toRgba = color => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = '#000'
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
        return [r, g, b, a / 255]
    }
    const layers = []
    for (let node = element; node; node = node.parentElement) {
        const rgba = toRgba(getComputedStyle(node).backgroundColor)
        if (rgba[3] > 0) layers.push(rgba)
        if (rgba[3] >= 0.999) break
    }
    let bg = [255, 255, 255]
    for (const [r, g, b, a] of layers.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)]
    const style = getComputedStyle(element)
    const [fr, fg, fb, fa] = toRgba(style.color)
    const text = [fr * fa + bg[0] * (1 - fa), fg * fa + bg[1] * (1 - fa), fb * fa + bg[2] * (1 - fa)]
    const lum = rgb => rgb
        .map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const l1 = lum(text)
    const l2 = lum(bg)
    return {
        text: element.textContent.trim().slice(0, 24),
        ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
    }
}

async function runCheck(results, name, fn) {
    try {
        await fn()
        console.log(`PASS: ${name}`)
        results.push({ name, ok: true })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`FAIL: ${name}\n  ${message}`)
        results.push({ name, ok: false, message })
    }
}

async function main() {
    const server = process.env.QA_AUDIT_URL
        ? null
        : run(npmCommand, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'])
    const results = []
    try {
        if (server) await waitForReady(server)
        const browser = await chromium.launch()
        const check = (name, viewport, fn) => runCheck(results, name, async () => {
            const { context, page } = await openPage(browser, viewport)
            try { await fn(page) } finally { await context.close() }
        })
        try {
            // Button on the scene prompt editor toolbar, then Ctrl+F: shortcut -> event -> SceneDetail listener.
            for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
                await check(`Scene detail ${viewport.width}px: fragment preview button and Ctrl+F open the dialog`, viewport, async page => {
                    await createSceneDetail(page)
                    const button = page.locator('[data-testid="scene-fragment-preview-action"]')
                    await button.scrollIntoViewIfNeeded()
                    assert.equal(await button.isVisible(), true, 'Fragment preview button is not visible')
                    await button.click()
                    const dialog = page.locator('[role="dialog"][data-state="open"]')
                    await dialog.first().waitFor({ state: 'visible' })
                    await page.keyboard.press('Escape')
                    await dialog.first().waitFor({ state: 'detached' })
                    await blurActiveElement(page)
                    await page.keyboard.press('Control+f')
                    await dialog.first().waitFor({ state: 'visible', timeout: 5_000 })
                })
            }

            await check('/scenes with one scene: one batch counter, set to 3 adds 3 to that scene, one filled primary button', { width: 1440, height: 1000 }, async page => {
                const sceneId = await createSceneDetail(page)
                await navigateByMenuShortcut(page, 3, '/scenes')
                const counters = page.locator('[data-testid="scene-batch-counter"]')
                await counters.first().waitFor({ state: 'visible' })
                const visibleCounters = await counters.evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width > 0).length)
                assert.equal(visibleCounters, 1, `Expected exactly one visible batch counter, saw ${visibleCounters}`)

                const counter = counters.first()
                const increase = counter.locator('button').last()
                await increase.click()
                await increase.click()
                // The rolling digits render every numeral, so the display button's label carries the value.
                const display = counter.locator('button').nth(1)
                await page.waitForFunction(node => /(^|\D)3(\D|$)/.test(node.getAttribute('aria-label') ?? ''), await display.elementHandle())

                const readQueueCount = () => page.evaluate(async id => {
                    const { useSceneStore } = await import('/src/stores/scene-store.ts')
                    for (const preset of useSceneStore.getState().presets) {
                        const scene = preset.scenes.find(item => item.id === id)
                        if (scene) return scene.queueCount
                    }
                    return null
                }, sceneId)
                const before = await readQueueCount()
                await page.locator('main button[aria-label$="대기열 늘리기"]').first().click()
                await page.waitForFunction(async ([id, expected]) => {
                    const { useSceneStore } = await import('/src/stores/scene-store.ts')
                    return useSceneStore.getState().presets.some(preset => preset.scenes.some(scene => scene.id === id && scene.queueCount === expected))
                }, [sceneId, before + 3], { timeout: 5_000 }).catch(() => {})
                assert.equal(await readQueueCount(), before + 3, `Queue went ${before} -> ${await readQueueCount()} instead of +3`)

                const filledPrimary = await page.locator('main').evaluate(root => {
                    const probe = document.createElement('span')
                    probe.style.backgroundColor = 'oklch(var(--primary))'
                    document.body.append(probe)
                    const primary = getComputedStyle(probe).backgroundColor
                    probe.remove()
                    return [...root.querySelectorAll('button, a')].filter(node => {
                        const rect = node.getBoundingClientRect()
                        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).backgroundColor === primary
                    }).length
                })
                assert.equal(filledPrimary, 1, `Expected one filled primary button on /scenes, saw ${filledPrimary}`)
            })

            await check('/advanced rail Steps: clear and retype keeps 30, empty blur restores the previous value', { width: 1440, height: 1000 }, async page => {
                await openAdvanced(page)
                const steps = page.locator('#nai-blue-prompt-dock [data-prompt-focus="steps"]')
                await steps.waitFor({ state: 'visible' })
                assert.equal(await steps.inputValue(), '28', 'Default Steps should be 28')
                await steps.click()
                await page.keyboard.press('End')
                await page.keyboard.press('Backspace')
                await page.keyboard.press('Backspace')
                await page.keyboard.type('30')
                await page.keyboard.press('Tab')
                assert.equal(await steps.inputValue(), '30', 'Steps should read 30 after backspacing 28 and typing 30')
                await steps.click()
                await page.keyboard.press('Control+a')
                await page.keyboard.press('Backspace')
                assert.equal(await steps.inputValue(), '', 'Steps should be clearable while focused')
                await page.keyboard.press('Tab')
                assert.equal(await steps.inputValue(), '30', 'Leaving Steps empty should restore the previous value')
            })

            for (const theme of ['light', 'dark']) {
                await check(`${theme} theme: scene detail cost text and primary-button <kbd> reach ${MIN_CONTRAST}:1`, { width: 1440, height: 1000 }, async page => {
                    await createSceneDetail(page)
                    await setTheme(page, theme)
                    // The command bar sits beside, not inside, the scene-detail workspace element.
                    const workspace = page.locator('main')
                    const cost = workspace.locator('[aria-label*="Anlas"]').first()
                    await cost.waitFor({ state: 'visible' })
                    const measured = [['scene cost', await cost.evaluate(contrastOf)]]
                    // Disabled controls are exempt from WCAG contrast, so only enabled buttons' <kbd> count.
                    for (const kbd of await workspace.locator('button:not([disabled]) kbd').all()) {
                        if (await kbd.isVisible()) measured.push(['scene button kbd', await kbd.evaluate(contrastOf)])
                    }
                    await navigateByMenuShortcut(page, 2, '/advanced')
                    const railKbd = page.locator('[data-testid="main-generate-action"] kbd').first()
                    await railKbd.waitFor({ state: 'visible' })
                    measured.push(['rail generate kbd', await railKbd.evaluate(contrastOf)])
                    const low = measured.filter(([, result]) => result.ratio < MIN_CONTRAST)
                    assert.deepEqual(low, [], `Below ${MIN_CONTRAST}:1 → ${JSON.stringify(low)}`)
                    console.log(`  ${theme}: ${measured.map(([name, result]) => `${name} "${result.text}" ${result.ratio}`).join(' · ')}`)
                })
            }

            for (const viewport of [{ width: 768, height: 900 }, { width: 1200, height: 800 }]) {
                await check(`Header prompt and history buttons are ${MIN_TARGET}x${MIN_TARGET}+ at ${viewport.width}px`, viewport, async page => {
                    await page.goto(`${baseUrl}/advanced`, { waitUntil: 'domcontentloaded' })
                    const actions = page.locator('header .workspace-editor-actions')
                    await actions.waitFor({ state: 'visible' })
                    for (const [name, selector] of [
                        ['prompt', 'button[aria-controls^="nai-blue-prompt"]'],
                        ['history', 'button[aria-controls="nai-blue-history-sheet"]'],
                    ]) {
                        const box = await actions.locator(selector).first().boundingBox()
                        assert.ok(box, `${name} button is not rendered`)
                        assert.ok(box.width >= MIN_TARGET && box.height >= MIN_TARGET, `${name} button is ${box.width}x${box.height}`)
                    }
                })
            }

            await check('/queue with a scene and no jobs hides the batch toolbar', { width: 1440, height: 1000 }, async page => {
                await createSceneDetail(page)
                await navigateByMenuShortcut(page, 4, '/queue')
                const header = page.locator('[data-testid="queue-center-ready"] .workspace-queue-header')
                await header.waitFor({ state: 'visible' })
                assert.equal(await header.locator('a[href="/review-queue-preview"]').isVisible(), true, 'Review-first link should stay')
                assert.equal(await header.locator('select').count(), 0, 'Job group select should not render without jobs')
                for (const icon of ['lucide-pause', 'lucide-play', 'lucide-rotate-ccw']) {
                    assert.equal(await header.locator(`button:has(svg.${icon})`).count(), 0, `${icon} control should not render without jobs`)
                }
                assert.equal(await header.locator('button.bg-destructive').count(), 0, 'Cancel-all should not render without jobs')
            })

            await check('/advanced 1440px: palette "prompt" keeps the rail, Esc returns focus to the editor', { width: 1440, height: 1000 }, async page => {
                const editor = await openAdvanced(page)
                await editor.click()
                await page.keyboard.press('Control+k')
                const palette = page.locator('[data-testid="command-palette"]')
                await palette.waitFor({ state: 'visible' })
                await page.keyboard.press('Escape')
                await palette.waitFor({ state: 'hidden' })
                const focusedEditor = await editor.evaluate(node => document.activeElement === node)
                assert.equal(focusedEditor, true, 'Closing the palette with Esc should return focus to the prompt editor')

                await page.keyboard.press('Control+k')
                await palette.waitFor({ state: 'visible' })
                await palette.locator('input[role="combobox"]').fill('프롬프트')
                await palette.locator('[role="option"][id$="panel:prompt"]').click()
                await palette.waitFor({ state: 'hidden' })
                await page.waitForTimeout(300)
                assert.equal(await page.locator('#nai-blue-prompt-dock').isVisible(), true, 'The prompt command hid the docked rail')
                assert.equal(await editor.isVisible(), true, 'The rail editor should stay visible')
            })

            await check('/folders inline editor: Esc on Cancel closes, Ctrl+Enter on Save saves without the route action', { width: 1440, height: 1000 }, async page => {
                await page.goto(`${baseUrl}/folders`, { waitUntil: 'domcontentloaded' })
                await page.locator('[data-testid="folder-workbench"]').waitFor({ state: 'visible' })
                await page.evaluate(() => {
                    window.__qaRouteGenerate = 0
                    window.addEventListener('shortcut:generate', () => { window.__qaRouteGenerate += 1 })
                })
                const composer = page.locator('.fb-composer textarea').first()
                await composer.waitFor({ state: 'visible' })
                const cards = page.locator('.fb-asset-card')
                const before = await cards.count()
                await composer.fill('qa_audit_asset')
                await composer.press('Control+Enter')
                await page.waitForFunction(count => document.querySelectorAll('.fb-asset-card').length > count, before)

                const card = cards.filter({ hasText: 'qa_audit_asset' }).first()
                const editorBox = page.locator('.fb-inline-editor')
                // The preview button shares the label; the visible "설명 편집" text button opens the inline editor.
                const editButton = card.locator('button:not(.fb-open-preview)[aria-label$="설명 편집"]')
                await editButton.click()
                await editorBox.waitFor({ state: 'visible' })
                await editorBox.locator('.fb-inline-editor-actions button').nth(1).focus()
                await page.keyboard.press('Escape')
                await editorBox.waitFor({ state: 'detached', timeout: 5_000 })

                await editButton.click()
                await editorBox.waitFor({ state: 'visible' })
                await editorBox.locator('textarea').fill('qa_audit_edited')
                await editorBox.locator('.fb-inline-editor-actions button').nth(0).focus()
                await page.keyboard.press('Control+Enter')
                await editorBox.waitFor({ state: 'detached', timeout: 5_000 })
                await page.locator('.fb-asset-card', { hasText: 'qa_audit_edited' }).first().waitFor({ state: 'visible' })
                assert.equal(await page.evaluate(() => window.__qaRouteGenerate), 0, 'Ctrl+Enter on Save also ran the /folders primary action')
                assert.equal(await page.locator('[role="dialog"][data-state="open"]').count(), 0, 'Ctrl+Enter on Save opened a dialog')
                assert.equal(new URL(page.url()).pathname, '/folders')
            })
        } finally {
            await browser.close()
        }
    } finally {
        await closeServer(server)
    }

    const failed = results.filter(item => !item.ok)
    console.log(`\nAudit regression QA: ${results.length - failed.length}/${results.length} passed`)
    if (failed.length > 0) process.exit(1)
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
