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
        window.__qaGenerationCount = 0
        window.__qaAuthUnsub = useAuthStore.subscribe((state, prev) => {
            if (!prev.tokenDialogOpen && state.tokenDialogOpen) {
                window.__qaGenerationCount += 1
                window.__qaGenerationTrigger = {
                    basePrompt: useGenerationStore.getState().basePrompt,
                    timestamp: Date.now(),
                }
            }
        })
    })
}

async function closeTokenDialog(page) {
    await page.evaluate(async () => {
        const { useAuthStore } = await import('/src/stores/auth-store.ts')
        useAuthStore.getState().setTokenDialogOpen(false)
    })
    await page.waitForFunction(() => document.querySelector('[role="dialog"][data-state="open"]:not([data-shortcut-scope="workspace"])') === null)
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
            triggerCount: window.__qaGenerationCount ?? 0,
        }
    })
}

/**
 * Records keydown events (read after dispatch, so defaultPrevented is final) and
 * shortcut CustomEvents emitted by useShortcuts. Reinstalled after each navigation.
 */
async function resetKeyProbe(page) {
    await page.evaluate(() => {
        if (!window.__qaKeyProbeInstalled) {
            window.__qaKeyProbeInstalled = true
            window.addEventListener('keydown', event => {
                if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return
                window.__qaKeyEvents.push(event)
            }, true)
            for (const name of [
                'shortcut:generate',
                'shortcut:openFragmentDialog',
                'shortcut:openParameterSettings',
                'shortcut:openPromptGenerator',
                'shortcut:resetFragmentCounters',
            ]) {
                window.addEventListener(name, () => {
                    window.__qaShortcutEvents[name] = (window.__qaShortcutEvents[name] ?? 0) + 1
                })
            }
        }
        window.__qaKeyEvents = []
        window.__qaShortcutEvents = {}
    })
}

async function readKeyProbe(page) {
    return page.evaluate(() => ({
        keys: (window.__qaKeyEvents ?? []).map(event => ({
            key: event.key,
            repeat: event.repeat,
            defaultPrevented: event.defaultPrevented,
        })),
        shortcutEvents: { ...(window.__qaShortcutEvents ?? {}) },
    }))
}

async function blurActiveElement(page) {
    await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
}

async function openAdvanced(page) {
    await page.goto(`${baseUrl}/advanced`, { waitUntil: 'domcontentloaded' })
    const editor = page.locator('#nai-blue-prompt-dock [data-testid="prompt-editor-surface"] textarea')
    await editor.waitFor({ state: 'visible' })
    return editor
}

async function openQaSceneDetail(page) {
    await page.goto(`${baseUrl}/scenes`, { waitUntil: 'domcontentloaded' })
    await page.locator('main button:has(svg.lucide-plus)').first().waitFor({ state: 'visible' })
    // Other "+" buttons (queue and batch counters) share the icon; "add scene" repeats its
    // aria-label as visible text, and the empty state has its own test id.
    await page.locator('main button:has(svg.lucide-plus)').evaluateAll(buttons => {
        for (const button of buttons) {
            const label = button.getAttribute('aria-label')
            const text = button.querySelector('span')?.textContent?.trim()
            if (button.dataset.testid === 'scene-empty-create' || (label && label === text)) {
                button.setAttribute('data-qa-add-scene', '')
            }
        }
    })
    const addButton = page.locator('[data-qa-add-scene]').first()
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

            // Case 1: Ctrl+Enter / Cmd+Enter inside AI Prompt Generator dialog must not trigger background generation
            for (const [chord, label] of [['Control+Enter', 'Ctrl+Enter'], ['Meta+Enter', 'Meta+Enter']]) {
                await runCheck(results, `Dialog ${label} does not trigger background generation`, async () => {
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
                        await dialogTextarea.press(chord)
                        await page.waitForTimeout(250)

                        const signal = await readGenerationSignal(page)
                        assert.equal(
                            signal.tokenDialogOpen,
                            false,
                            `${label} inside PromptGeneratorDialog leaked to global action:generate (tokenDialogOpen became true)`,
                        )
                    } finally {
                        await resetAuthAndDraft(page)
                        await openAdvanced(page)
                    }
                })
            }

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

                const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
                const darkBefore = await isDark()
                const toggleTheme = async () => {
                    await page.keyboard.press('Control+k')
                    await palette.waitFor({ state: 'visible' })
                    await input.fill('theme')
                    await palette.locator('[role="option"][id$="action:theme"]').waitFor({ state: 'visible' })
                    await input.press('Enter')
                    await palette.waitFor({ state: 'hidden', timeout: 5000 })
                }
                await toggleTheme()
                assert.equal(await isDark(), !darkBefore, 'Theme command from the palette did not toggle the dark class')
                await toggleTheme()
                assert.equal(await isDark(), darkBefore, 'Second theme command did not restore the original theme')
            })

            // Case 11: Per-route Ctrl+Enter submits Folder composer locally and runs the SceneDetail primary action
            await runCheck(results, 'Per-route Ctrl+Enter submits Folder composer locally and runs SceneDetail primary action', async () => {
                await page.goto(`${baseUrl}/folders`, { waitUntil: 'domcontentloaded' })
                await page.locator('[data-testid="folder-workbench"]').waitFor({ state: 'visible' })
                await resetKeyProbe(page)
                const composerTextarea = page.locator('.fb-composer textarea').first()
                await composerTextarea.waitFor({ state: 'visible' })
                const cardsBefore = await page.locator('.fb-asset-card').count()
                await composerTextarea.fill('ctrl_enter_folder_asset')
                await composerTextarea.press('Control+Enter')
                await page.waitForFunction(
                    before => document.querySelectorAll('.fb-asset-card').length > before,
                    cardsBefore,
                    { timeout: 5000 },
                )
                const folderProbe = await readKeyProbe(page)
                assert.equal(
                    folderProbe.shortcutEvents['shortcut:generate'] ?? 0,
                    0,
                    'Ctrl+Enter inside the folder composer leaked to the route primary action',
                )

                const scenePath = await openQaSceneDetail(page)
                const sceneId = scenePath.split('/').pop()
                const readQueueCount = () => page.evaluate(async id => {
                    const { useSceneStore } = await import('/src/stores/scene-store.ts')
                    for (const preset of useSceneStore.getState().presets) {
                        const scene = preset.scenes.find(item => item.id === id)
                        if (scene) return scene.queueCount
                    }
                    return null
                }, sceneId)
                assert.equal(await readQueueCount(), 0, 'New QA scene should start with an empty queue')
                await resetAuthAndDraft(page)
                await resetKeyProbe(page)
                await blurActiveElement(page)
                await page.keyboard.press('Control+Enter')
                await page.waitForTimeout(300)
                const sceneProbe = await readKeyProbe(page)
                assert.equal(sceneProbe.shortcutEvents['shortcut:generate'] ?? 0, 1, 'SceneDetail Ctrl+Enter did not emit the route primary action')
                assert.ok(
                    (await readQueueCount()) >= 1,
                    'SceneDetail primary action did not queue the scene (queueCount stayed 0)',
                )
                await closeTokenDialog(page)
            })

            // Case 12: an open model Select listbox owns Ctrl+Enter; generation must not run underneath it
            await runCheck(results, 'Model select listbox open: Ctrl+Enter does not trigger generation', async () => {
                const editor = await openAdvanced(page)
                await resetAuthAndDraft(page)
                await editor.fill('listbox_guard_prompt')
                const modelSelect = page.locator('[data-testid="prompt-core-parameters"] [role="combobox"]').first()
                await modelSelect.click()
                const listbox = page.locator('[role="listbox"][data-state="open"]')
                await listbox.first().waitFor({ state: 'visible' })
                await resetKeyProbe(page)
                await page.keyboard.press('Control+Enter')
                await page.waitForTimeout(250)

                const signal = await readGenerationSignal(page)
                const probe = await readKeyProbe(page)
                assert.equal(signal.tokenDialogOpen, false, 'Ctrl+Enter with the model listbox open triggered generation')
                assert.equal(probe.keys.at(-1)?.defaultPrevented, true, 'Suppressed Ctrl+Enter should still block the browser default')
                // Radix Select treats Ctrl+Enter on an item as Enter and closes before window
                // sees the key; a closed listbox proves the capture-time layer sample was exercised.
                assert.equal(await listbox.count(), 0, 'Expected Ctrl+Enter to select the focused option and close the listbox')
                await resetAuthAndDraft(page)
            })

            // Case 13: an open tools DropdownMenu owns Ctrl+Enter, on the menu and on a focused item
            await runCheck(results, 'Tools menu open: Ctrl+Enter does not trigger generation', async () => {
                const menu = page.locator('[role="menu"][data-state="open"]')
                for (const focusItem of [false, true]) {
                    const editor = await openAdvanced(page)
                    await resetAuthAndDraft(page)
                    await editor.fill('menu_guard_prompt')
                    await page.locator('button.fb-app-tools').click()
                    await menu.first().waitFor({ state: 'visible' })
                    if (focusItem) {
                        await page.keyboard.press('ArrowDown')
                        await page.locator('[role="menuitem"]:focus').waitFor({ state: 'visible' })
                    }
                    await resetKeyProbe(page)
                    await page.keyboard.press('Control+Enter')
                    await page.waitForTimeout(250)

                    const signal = await readGenerationSignal(page)
                    const probe = await readKeyProbe(page)
                    const where = focusItem ? 'a focused menu item' : 'the tools menu'
                    assert.equal(signal.tokenDialogOpen, false, `Ctrl+Enter on ${where} triggered generation`)
                    assert.equal(probe.shortcutEvents['shortcut:generate'] ?? 0, 0, `Ctrl+Enter on ${where} emitted the route action`)
                    assert.equal(probe.keys.at(-1)?.defaultPrevented, true, `Suppressed Ctrl+Enter on ${where} should block the browser default`)
                    if (!focusItem) await page.keyboard.press('Escape')
                    await resetAuthAndDraft(page)
                }
            })

            // Case 14: holding Ctrl+Enter (auto-repeat keydown) must not toggle generate/cancel
            await runCheck(results, 'Held Ctrl+Enter (repeat keydown) triggers generation once', async () => {
                const editor = await openAdvanced(page)
                await resetAuthAndDraft(page)
                await editor.click()
                await editor.fill('repeat_guard_prompt')
                await resetKeyProbe(page)
                await page.keyboard.down('Control')
                try {
                    await page.keyboard.down('Enter')
                    await page.waitForTimeout(200)
                    for (let i = 0; i < 3; i += 1) {
                        // Close the token dialog so only the repeat guard can stop a second trigger.
                        await closeTokenDialog(page)
                        await page.keyboard.down('Enter')
                        await page.waitForTimeout(150)
                    }
                } finally {
                    await page.keyboard.up('Enter')
                    await page.keyboard.up('Control')
                }

                const signal = await readGenerationSignal(page)
                const probe = await readKeyProbe(page)
                const enterEvents = probe.keys.filter(item => item.key === 'Enter')
                assert.equal(enterEvents.filter(item => item.repeat).length, 3, `Expected 3 repeat keydowns, saw ${JSON.stringify(enterEvents)}`)
                assert.equal(signal.triggerCount, 1, `Held Ctrl+Enter triggered generation ${signal.triggerCount} times`)
                assert.ok(enterEvents.every(item => item.defaultPrevented), 'Repeat Ctrl+Enter keydowns must keep the browser default blocked')
                await closeTokenDialog(page)
                await resetAuthAndDraft(page)
            })

            // Case 15: off /advanced, Ctrl+Enter typed inside the prompt sheet runs the sheet's main generation
            await runCheck(results, 'Prompt sheet on /folders: Ctrl+Enter runs main generation, not the route action', async () => {
                await page.goto(`${baseUrl}/folders`, { waitUntil: 'domcontentloaded' })
                await page.locator('[data-testid="folder-workbench"]').waitFor({ state: 'visible' })
                await resetAuthAndDraft(page)
                await resetKeyProbe(page)

                await page.keyboard.press('Control+k')
                const palette = page.locator('[data-testid="command-palette"]')
                await palette.waitFor({ state: 'visible' })
                await palette.locator('input[role="combobox"]').fill('prompt')
                await palette.locator('[role="option"][id$="panel:prompt"]').click()
                await palette.waitFor({ state: 'hidden' })

                const sheet = page.locator('#nai-blue-prompt-sheet')
                await sheet.waitFor({ state: 'visible' })
                const sheetEditor = sheet.locator('[data-testid="prompt-editor-surface"] textarea').first()
                await sheetEditor.click()
                await sheetEditor.fill('')
                await sheetEditor.pressSequentially('folders_sheet_prompt', { delay: 0 })
                await sheetEditor.press('Control+Enter')
                await page.waitForTimeout(250)

                const signal = await readGenerationSignal(page)
                const probe = await readKeyProbe(page)
                assert.equal(signal.tokenDialogOpen, true, 'Ctrl+Enter inside the prompt sheet did not run main generation')
                assert.equal(signal.promptAtTrigger, 'folders_sheet_prompt', `Expected sheet prompt at trigger, got "${signal.promptAtTrigger}"`)
                assert.equal(probe.shortcutEvents['shortcut:generate'] ?? 0, 0, 'Ctrl+Enter inside the prompt sheet also fired the /folders route action')
                await closeTokenDialog(page)
                await resetAuthAndDraft(page)
            })

            // Case 16: app-owned keys keep WebView defaults blocked even when the action does not run here
            await runCheck(results, 'Unrun app shortcuts still block browser defaults; Ctrl+F opens fragments only on SceneDetail', async () => {
                await page.goto(`${baseUrl}/folders`, { waitUntil: 'domcontentloaded' })
                await page.locator('[data-testid="folder-workbench"]').waitFor({ state: 'visible' })
                await resetKeyProbe(page)
                await blurActiveElement(page)
                await page.keyboard.press('Control+f')
                await page.keyboard.press('Control+p')
                let probe = await readKeyProbe(page)
                assert.deepEqual(
                    probe.keys.map(item => [item.key, item.defaultPrevented]),
                    [['f', true], ['p', true]],
                    'Ctrl+F / Ctrl+P on /folders must not fall through to the find bar or print dialog',
                )
                assert.deepEqual(probe.shortcutEvents, {}, 'Ctrl+F / Ctrl+P on /folders must not emit authoring dialog events')

                await page.evaluate(async () => {
                    const { useAuthStore } = await import('/src/stores/auth-store.ts')
                    useAuthStore.getState().requestTokenEntry()
                })
                await page.locator('[role="dialog"][data-state="open"]').first().waitFor({ state: 'visible' })
                await resetKeyProbe(page)
                await page.keyboard.press('Control+Shift+R')
                probe = await readKeyProbe(page)
                assert.equal(probe.keys.at(-1)?.defaultPrevented, true, 'Ctrl+Shift+R under a dialog must not reload the WebView')
                assert.deepEqual(probe.shortcutEvents, {}, 'Ctrl+Shift+R under a dialog must not reset fragment counters')
                await closeTokenDialog(page)

                await openQaSceneDetail(page)
                await resetKeyProbe(page)
                await blurActiveElement(page)
                await page.keyboard.press('Control+f')
                probe = await readKeyProbe(page)
                assert.equal(probe.keys.at(-1)?.defaultPrevented, true, 'Ctrl+F on SceneDetail must not open the find bar')
                assert.equal(probe.shortcutEvents['shortcut:openFragmentDialog'] ?? 0, 1, 'Ctrl+F on SceneDetail must emit the fragment dialog event')
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
