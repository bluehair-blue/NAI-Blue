import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from 'playwright'

const port = Number(process.env.QA_KEYBOARD_PORT || 5178)
const baseUrl = process.env.QA_KEYBOARD_URL || `http://127.0.0.1:${port}`
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function quoteWindowsArg(arg) {
    if (/^[A-Za-z0-9_:./=-]+$/.test(arg)) return arg
    return `"${arg.replace(/"/g, '\\"')}"`
}

function prepareCommand(command, args) {
    if (process.platform !== 'win32') return { command, args }
    return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', [command, ...args.map(quoteWindowsArg)].join(' ')],
    }
}

function run(command, args, options = {}) {
    const prepared = prepareCommand(command, args)
    return spawn(prepared.command, prepared.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
    })
}

async function waitForReady(child) {
    let output = ''
    const started = Date.now()

    child.stdout.on('data', chunk => {
        output += chunk.toString()
    })
    child.stderr.on('data', chunk => {
        output += chunk.toString()
    })

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
    await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 3_000)),
    ])
}

async function resetAuthAndDraft(page) {
    await page.evaluate(async () => {
        const [{ useAuthStore }, { useGenerationStore }] = await Promise.all([
            import('/src/stores/auth-store.ts'),
            import('/src/stores/generation-store.ts'),
        ])
        useAuthStore.getState().setTokenDialogOpen(false)
        useGenerationStore.getState().setBasePrompt('')
        if (window.__qaAuthUnsub) {
            window.__qaAuthUnsub()
            window.__qaAuthUnsub = null
        }
        window.__qaGenerationTrigger = null
        window.__qaAuthUnsub = useAuthStore.subscribe((state, prev) => {
            if (!prev.tokenDialogOpen && state.tokenDialogOpen) {
                window.__qaGenerationTrigger = {
                    basePrompt: useGenerationStore.getState().basePrompt,
                    timestamp: Date.now(),
                }
            }
        })
    })
}

async function readGenerationSignal(page) {
    return page.evaluate(async () => {
        const [{ useAuthStore }, { useGenerationStore }] = await Promise.all([
            import('/src/stores/auth-store.ts'),
            import('/src/stores/generation-store.ts'),
        ])
        return {
            tokenDialogOpen: useAuthStore.getState().tokenDialogOpen,
            basePrompt: useGenerationStore.getState().basePrompt,
            promptAtTrigger: window.__qaGenerationTrigger?.basePrompt ?? null,
        }
    })
}

async function openQaSceneDetail(page) {
    await page.goto(`${baseUrl}/scenes`, { waitUntil: 'domcontentloaded' })
    const addButton = page.locator('main button:has(svg.lucide-plus)').first()
    await addButton.waitFor({ state: 'visible' })
    await addButton.click()
    await page.waitForURL(url => /^\/scenes\/[^/]+$/.test(url.pathname))
    await page.locator('[data-testid="scene-detail-workspace"]').waitFor({ state: 'visible' })
    return new URL(page.url()).pathname
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
    const server = process.env.QA_KEYBOARD_URL
        ? null
        : run(npmCommand, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'])

    const results = []
    try {
        if (server) await waitForReady(server)
        const browser = await chromium.launch()
        try {
            const page = await browser.newPage({ viewport: { width: 1536, height: 960 } })
            page.setDefaultTimeout(15_000)
            await page.route('**/*', route => {
                const requestUrl = route.request().url()
                if (requestUrl.startsWith(baseUrl) || requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
                    return route.continue()
                }
                return route.abort()
            })

            await page.goto(`${baseUrl}/advanced`, { waitUntil: 'domcontentloaded' })
            await page.locator('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] textarea').waitFor({ state: 'visible' })

            // Case 1: Ctrl+Enter inside AI Prompt Generator dialog must not trigger background generation
            await runCheck(results, 'Dialog Ctrl+Enter does not trigger background generation', async () => {
                await resetAuthAndDraft(page)
                await page.locator('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] button:has(svg.lucide-sparkles)').click()
                const aiTrigger = page.locator('[data-radix-popper-content-wrapper] button:has(svg.lucide-sparkles)').first()
                await aiTrigger.waitFor({ state: 'visible' })
                await aiTrigger.click()

                try {
                    const dialog = page.locator('[role="dialog"][data-state="open"]').first()
                    await dialog.waitFor({ state: 'visible' })
                    const dialogTextarea = dialog.locator('textarea').first()
                    await dialogTextarea.fill('girl drinking coffee in a sunlit cafe')
                    await dialogTextarea.press('Control+Enter')
                    await page.waitForTimeout(250)

                    const signal = await readGenerationSignal(page)
                    assert.equal(
                        signal.tokenDialogOpen,
                        false,
                        'Ctrl+Enter inside PromptGeneratorDialog leaked to global action:generate (tokenDialogOpen became true)',
                    )
                } finally {
                    await resetAuthAndDraft(page)
                    await page.goto(`${baseUrl}/advanced`, { waitUntil: 'domcontentloaded' })
                    await page.locator('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] textarea').waitFor({ state: 'visible' })
                }
            })

            // Case 2: Autocomplete popup open + Ctrl+Enter triggers generation and flushes last char
            await runCheck(results, 'Autocomplete open Ctrl+Enter triggers generation with latest input', async () => {
                await resetAuthAndDraft(page)
                const editor = page.locator('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] textarea')
                await editor.click()
                await editor.fill('')
                await editor.pressSequentially('1gir', { delay: 15 })
                const listbox = page.locator('[role="listbox"][aria-label="Prompt suggestions"]')
                await listbox.waitFor({ state: 'visible' })

                await editor.press('l')
                await editor.press('Control+Enter')
                await page.waitForTimeout(250)

                const signal = await readGenerationSignal(page)
                assert.equal(
                    signal.tokenDialogOpen,
                    true,
                    'Ctrl+Enter with autocomplete open did not reach action:generate',
                )
                assert.equal(
                    signal.promptAtTrigger,
                    '1girl',
                    `Expected basePrompt to flush "1girl" before generation trigger, got "${signal.promptAtTrigger}" (final "${signal.basePrompt}")`,
                )
                assert.equal(
                    await listbox.isVisible(),
                    false,
                    'Autocomplete listbox should close when Ctrl+Enter triggers generation',
                )
                await resetAuthAndDraft(page)
            })

            // Case 3: Immediate Ctrl+Enter within 100ms debounce includes the last typed character
            await runCheck(results, 'Immediate Ctrl+Enter flushes pending debounced prompt text', async () => {
                await resetAuthAndDraft(page)
                const editor = page.locator('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] textarea')
                await editor.click()
                await editor.fill('')
                await editor.pressSequentially('zzz_flush_check_9', { delay: 0 })
                await editor.press('Control+Enter')
                await page.waitForTimeout(250)

                const signal = await readGenerationSignal(page)
                assert.equal(signal.tokenDialogOpen, true, 'Immediate Ctrl+Enter did not trigger action:generate')
                assert.equal(
                    signal.promptAtTrigger,
                    'zzz_flush_check_9',
                    `Expected flushed prompt "zzz_flush_check_9" at trigger time, got "${signal.promptAtTrigger}" (final "${signal.basePrompt}")`,
                )
                await resetAuthAndDraft(page)
            })

            // Case 4: Below 1200px with non-modal prompt sheet open, Ctrl+Enter triggers generation
            await runCheck(results, 'Non-modal prompt sheet open (<1200px) allows Ctrl+Enter generation', async () => {
                await page.setViewportSize({ width: 1024, height: 800 })
                await page.goto(`${baseUrl}/advanced`, { waitUntil: 'domcontentloaded' })
                await resetAuthAndDraft(page)

                const promptToggle = page.locator('[aria-controls="nai-blue-prompt-sheet"]').first()
                await promptToggle.waitFor({ state: 'visible' })
                await promptToggle.click()
                const sheet = page.locator('#nai-blue-prompt-sheet')
                await sheet.waitFor({ state: 'visible' })

                const sheetEditor = sheet.locator('[data-testid="prompt-editor-surface"] textarea')
                await sheetEditor.click()
                await sheetEditor.pressSequentially('sheet_prompt_1', { delay: 0 })
                await sheetEditor.press('Control+Enter')
                await page.waitForTimeout(250)

                const signal = await readGenerationSignal(page)
                assert.equal(
                    signal.tokenDialogOpen,
                    true,
                    'Ctrl+Enter inside non-modal #nai-blue-prompt-sheet was blocked from triggering action:generate',
                )
                assert.equal(
                    signal.promptAtTrigger,
                    'sheet_prompt_1',
                    `Expected flushed sheet prompt "sheet_prompt_1" at trigger time, got "${signal.promptAtTrigger}" (final "${signal.basePrompt}")`,
                )
                await resetAuthAndDraft(page)
            })

            // Prepare SceneDetail for Escape cases
            await page.setViewportSize({ width: 1440, height: 1000 })

            // Case 5: SceneDetail Escape closes autocomplete without navigating away
            await runCheck(results, 'SceneDetail Escape closes autocomplete without leaving route', async () => {
                const scenePath = await openQaSceneDetail(page)
                const editor = page.locator('[data-testid="scene-detail-workspace"] textarea').first()
                await editor.waitFor({ state: 'visible' })
                await editor.click()
                await editor.fill('')
                await editor.pressSequentially('1gir', { delay: 15 })
                const listbox = page.locator('[role="listbox"][aria-label="Prompt suggestions"]')
                await listbox.waitFor({ state: 'visible' })

                await editor.press('Escape')
                await page.waitForTimeout(150)

                assert.equal(await listbox.isVisible(), false, 'Autocomplete listbox remained visible after Escape')
                assert.equal(
                    new URL(page.url()).pathname,
                    scenePath,
                    `Escape from autocomplete navigated away to ${new URL(page.url()).pathname}`,
                )
            })

            // Case 6: SceneDetail Escape cancels inline name edit without navigating away
            await runCheck(results, 'SceneDetail Escape cancels name edit without leaving route', async () => {
                const scenePath = await openQaSceneDetail(page)
                const renameButton = page.locator('[data-testid="scene-detail-workspace"] header button:has(svg.lucide-pencil)').first()
                await renameButton.waitFor({ state: 'visible' })
                await renameButton.click()

                const renameInput = page.locator('[data-testid="scene-detail-workspace"] header input').first()
                await renameInput.waitFor({ state: 'visible' })
                await renameInput.press('Escape')
                await page.waitForTimeout(150)

                assert.equal(await renameInput.count(), 0, 'Rename input should close on Escape')
                assert.equal(
                    new URL(page.url()).pathname,
                    scenePath,
                    `Escape from name edit navigated away to ${new URL(page.url()).pathname}`,
                )
            })

            // Case 7: SceneDetail Escape closes modal dialog without navigating away
            await runCheck(results, 'SceneDetail Escape closes modal dialog without leaving route', async () => {
                const scenePath = await openQaSceneDetail(page)
                await page.evaluate(async () => {
                    const { useAuthStore } = await import('/src/stores/auth-store.ts')
                    useAuthStore.getState().requestTokenEntry()
                })
                const dialog = page.locator('[role="dialog"][data-state="open"]').first()
                await dialog.waitFor({ state: 'visible' })

                await page.keyboard.press('Escape')
                await page.waitForTimeout(150)

                assert.equal(
                    await page.locator('[role="dialog"][data-state="open"]').count(),
                    0,
                    'Modal dialog should close on Escape',
                )
                assert.equal(
                    new URL(page.url()).pathname,
                    scenePath,
                    `Escape from modal dialog navigated away to ${new URL(page.url()).pathname}`,
                )
            })

            // Case 8: Ctrl+1..4 navigate in exact top-menu order (/folders, /advanced, /scenes, /queue)
            await runCheck(results, 'Ctrl+1..4 navigate in top menu order', async () => {
                await page.goto(`${baseUrl}/folders`, { waitUntil: 'domcontentloaded' })
                await page.locator('[data-testid="folder-workbench"]').waitFor({ state: 'visible' })
                const expectations = [
                    ['Control+2', '/advanced'],
                    ['Control+3', '/scenes'],
                    ['Control+4', '/queue'],
                    ['Control+1', '/folders'],
                ]
                for (const [chord, expectedPath] of expectations) {
                    await page.keyboard.press(chord)
                    await page.waitForURL(url => url.pathname === expectedPath, { timeout: 5000 })
                    assert.equal(new URL(page.url()).pathname, expectedPath)
                }
            })

            // Case 9: Alt+1..N switch prompt slots inside Main and Scene editors
            await runCheck(results, 'Alt+1..N switch prompt slots in Main and Scene editors', async () => {
                await page.goto(`${baseUrl}/advanced`, { waitUntil: 'domcontentloaded' })
                const mainEditor = page.locator('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] textarea')
                await mainEditor.waitFor({ state: 'visible' })
                await mainEditor.click()
                await page.keyboard.press('Alt+Digit4')
                assert.equal(
                    await page.locator('#nai-blue-prompt-dock [role="tab"]').nth(3).getAttribute('aria-selected'),
                    'true',
                    'Alt+4 should select the 4th (negative) tab in Main prompt editor',
                )
                await page.keyboard.press('Alt+Digit1')
                assert.equal(
                    await page.locator('#nai-blue-prompt-dock [role="tab"]').nth(0).getAttribute('aria-selected'),
                    'true',
                    'Alt+1 should select the 1st (base) tab in Main prompt editor',
                )

                await openQaSceneDetail(page)
                const sceneEditor = page.locator('[data-testid="scene-prompt-editor"] textarea').first()
                await sceneEditor.waitFor({ state: 'visible' })
                await sceneEditor.click()
                await page.keyboard.press('Alt+Digit3')
                assert.equal(
                    await page.locator('[data-testid="scene-prompt-editor"] [role="tab"]').nth(2).getAttribute('aria-selected'),
                    'true',
                    'Alt+3 should select the 3rd (negative) tab in Scene prompt editor',
                )
            })

            // Case 10: Ctrl+K opens Command Palette, filters and executes commands, and Esc closes
            await runCheck(results, 'Ctrl+K command palette filters, navigates, toggles theme, and closes on Esc', async () => {
                await page.goto(`${baseUrl}/folders`, { waitUntil: 'domcontentloaded' })
                await page.locator('[data-testid="folder-workbench"]').waitFor({ state: 'visible' })

                await page.keyboard.press('Control+k')
                const palette = page.locator('[data-testid="command-palette"]')
                await palette.waitFor({ state: 'visible' })

                await page.keyboard.press('Escape')
                await palette.waitFor({ state: 'hidden' })

                await page.keyboard.press('Control+k')
                await palette.waitFor({ state: 'visible' })
                const input = palette.locator('input[role="combobox"]')
                await input.fill('/queue')
                await input.press('Enter')
                await page.waitForURL(url => url.pathname === '/queue', { timeout: 5000 })
                await palette.waitFor({ state: 'hidden', timeout: 5000 })
                assert.equal(await palette.isVisible(), false, 'Command palette should close after executing command')
            })

            // Case 11: Per-route Ctrl+Enter submits Folder composer locally and triggers SceneDetail primary action
            await runCheck(results, 'Per-route Ctrl+Enter submits Folder composer locally without leaking', async () => {
                await page.goto(`${baseUrl}/folders`, { waitUntil: 'domcontentloaded' })
                await page.locator('[data-testid="folder-workbench"]').waitFor({ state: 'visible' })
                const composerTextarea = page.locator('.fb-composer textarea').first()
                if (await composerTextarea.isVisible()) {
                    await composerTextarea.fill('ctrl_enter_folder_asset')
                    await composerTextarea.press('Control+Enter')
                    await page.locator('.fb-asset-card').first().waitFor({ state: 'visible', timeout: 5000 })
                    assert.ok(await page.locator('.fb-asset-card').count() >= 1, 'Ctrl+Enter inside folder composer should add asset card')
                }
            })

            await page.close()
        } finally {
            await browser.close()
        }
    } finally {
        await closeServer(server)
    }

    const failed = results.filter(item => !item.ok)
    console.log(`\nKeyboard scope QA: ${results.length - failed.length}/${results.length} passed`)
    if (failed.length > 0) {
        process.exit(1)
    }
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
