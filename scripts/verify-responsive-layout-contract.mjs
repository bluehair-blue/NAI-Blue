import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const VIEWPORTS = [
    { width: 390, height: 844, minCenterWidth: 330, sidebars: 'hidden', mobile: true },
    { width: 412, height: 915, minCenterWidth: 352, sidebars: 'hidden', mobile: true },
    { width: 768, height: 1024, minCenterWidth: 680, sidebars: 'hidden' },
    { width: 1280, height: 800, minCenterWidth: 1100, sidebars: 'hidden' },
    // Wide desktop restores both command sidebars, leaving the authoring/main
    // center intentionally narrower than the viewport.
    { width: 1536, height: 960, minCenterWidth: 680 },
    // The fully labelled primary navigation activates only on spacious desktops.
    { width: 1920, height: 1080, minCenterWidth: 980 },
]

const WIDE_COMPOSITION_ROUTES = ['/advanced', '/scenes', '/queue', '/r2']

// These routes represent each responsive information architecture used by the
// production shell: command canvas, split editor, dense grids, and settings.
const defaultRoutes = [
    '/folders',
    '/advanced',
    '/guided-preview',
    '/style-lab',
    '/scenes',
    '/tools',
    '/library',
    '/web',
    '/queue',
    '/r2',
    '/data',
    '/settings',
]
// A route filter keeps focused accessibility checks fast and isolates layout
// failures from unrelated page-startup delays in the full release gate.
const requestedRoutes = (process.env.RESPONSIVE_CONTRACT_ROUTES ?? '')
    .split(',')
    .map(route => route.trim())
    .filter(Boolean)
const routes = requestedRoutes.length > 0 ? requestedRoutes : defaultRoutes
const port = Number(process.env.RESPONSIVE_CONTRACT_PORT || 5177)
const baseUrl = process.env.RESPONSIVE_CONTRACT_URL || `http://127.0.0.1:${port}`
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const root = path.resolve(import.meta.dirname, '..')
const evidenceDir = process.env.RESPONSIVE_EVIDENCE_DIR
    ? path.resolve(process.env.RESPONSIVE_EVIDENCE_DIR)
    : null

if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true })
}

function routeSlug(route) {
    return route === '/advanced' ? 'main' : route.slice(1).replaceAll('/', '-')
}

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

function verifyDialogSourceContracts() {
    // Tool dialogs need image state that is intentionally absent from this
    // deterministic browser fixture. Keep their mobile-width requirement
    // executable without coupling the test to an authenticated/user data set.
    for (const relativePath of [
        'src/components/tools/I2IDialog.tsx',
        'src/components/tools/InpaintingDialog.tsx',
        'src/components/tools/MosaicDialog.tsx',
    ]) {
        const source = readFileSync(path.join(root, relativePath), 'utf8')
        assert.doesNotMatch(
            source,
            /(?:maxWidth|width)\s*:\s*['"]60vw['"]|(?:max-)?w-\[60vw\]/,
            `${relativePath} must not force a 60vw dialog on phone viewports`,
        )
    }
}

async function collectVisibleCtaReport(page, rootSelector = 'body') {
    return page.evaluate(({ selector }) => {
        const reportRoot = document.querySelector(selector)
        if (!reportRoot) {
            return { missingRoot: true, clipped: [], overlaps: [], count: 0 }
        }

        const CTA_SELECTOR = [
            'a[href]',
            'button',
            'input[type="button"]',
            'input[type="reset"]',
            'input[type="submit"]',
            '[role="button"]',
        ].join(',')
        const CLIPPING_VALUES = new Set(['auto', 'clip', 'hidden', 'scroll'])
        const CLIP_TOLERANCE = 2
        const OVERLAP_TOLERANCE = 2

        const intersect = (first, second) => ({
            left: Math.max(first.left, second.left),
            top: Math.max(first.top, second.top),
            right: Math.min(first.right, second.right),
            bottom: Math.min(first.bottom, second.bottom),
        })
        const dimensions = rect => ({
            width: Math.max(0, rect.right - rect.left),
            height: Math.max(0, rect.bottom - rect.top),
        })
        const rectSnapshot = rect => ({
            left: Math.round(rect.left * 10) / 10,
            top: Math.round(rect.top * 10) / 10,
            right: Math.round(rect.right * 10) / 10,
            bottom: Math.round(rect.bottom * 10) / 10,
            width: Math.round((rect.right - rect.left) * 10) / 10,
            height: Math.round((rect.bottom - rect.top) * 10) / 10,
        })
        const describe = (element, index) => {
            const testId = element.getAttribute('data-testid')
            const ariaLabel = element.getAttribute('aria-label')
            const title = element.getAttribute('title')
            const text = (element.textContent || element.getAttribute('value') || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 60)
            const id = element.id ? `#${element.id}` : ''
            return `${element.tagName.toLowerCase()}${id} ${testId || ariaLabel || title || text || `cta-${index}`}`.trim()
        }
        const isRendered = (element, rect) => {
            const style = getComputedStyle(element)
            // Closed native details retain descendant rectangles in Chromium.
            // checkVisibility excludes those unpainted controls without weakening overlap checks.
            return element.checkVisibility() && !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.visibility !== 'collapse' &&
                Number.parseFloat(style.opacity || '1') > 0.01 &&
                rect.width >= 8 &&
                rect.height >= 8
        }
        const viewportClip = {
            left: 0,
            top: 0,
            right: document.documentElement.clientWidth,
            bottom: window.innerHeight,
        }
        const candidates = Array.from(reportRoot.querySelectorAll(CTA_SELECTOR))
            // Nested interactive markup produces the same visual CTA twice.
            .filter(element => !element.parentElement?.closest(CTA_SELECTOR))
            .map((element, index) => {
                const rect = element.getBoundingClientRect()
                if (!isRendered(element, rect)) return null

                let clip = viewportClip
                let topClipIsNonScrollable = false
                let bottomClipIsNonScrollable = false
                for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
                    const style = getComputedStyle(ancestor)
                    const ancestorRect = ancestor.getBoundingClientRect()
                    const clipsX = CLIPPING_VALUES.has(style.overflowX) || style.contain.includes('paint')
                    const clipsY = CLIPPING_VALUES.has(style.overflowY) || style.contain.includes('paint')
                    if (clipsX) {
                        clip = intersect(clip, {
                            left: ancestorRect.left,
                            top: Number.NEGATIVE_INFINITY,
                            right: ancestorRect.right,
                            bottom: Number.POSITIVE_INFINITY,
                        })
                    }
                    if (clipsY) {
                        const nonScrollable = style.overflowY === 'hidden' ||
                            style.overflowY === 'clip' ||
                            style.contain.includes('paint')
                        if (ancestorRect.top > clip.top) {
                            clip = { ...clip, top: ancestorRect.top }
                            topClipIsNonScrollable = nonScrollable
                        }
                        if (ancestorRect.bottom < clip.bottom) {
                            clip = { ...clip, bottom: ancestorRect.bottom }
                            bottomClipIsNonScrollable = nonScrollable
                        }
                    }
                }

                const visibleRect = intersect(rect, clip)
                const visibleDimensions = dimensions(visibleRect)
                if (visibleDimensions.width <= 1 || visibleDimensions.height <= 1) return null

                const horizontalLoss = Math.max(0, clip.left - rect.left, rect.right - clip.right)
                const topLoss = Math.max(0, clip.top - rect.top)
                const bottomLoss = Math.max(0, rect.bottom - clip.bottom)
                const verticalLoss = Math.max(topLoss, bottomLoss)
                const unsafeVerticalLoss = Math.max(
                    topClipIsNonScrollable ? topLoss : 0,
                    bottomClipIsNonScrollable ? bottomLoss : 0,
                )
                const area = Math.max(1, rect.width * rect.height)
                const visibleRatio = (visibleDimensions.width * visibleDimensions.height) / area
                const materiallyVisible = visibleRatio >= 0.35 &&
                    visibleDimensions.width >= Math.min(16, rect.width) &&
                    visibleDimensions.height >= Math.min(16, rect.height)

                return {
                    element,
                    label: describe(element, index),
                    rect,
                    visibleRect,
                    clipped: materiallyVisible && (
                        horizontalLoss > CLIP_TOLERANCE ||
                        unsafeVerticalLoss > CLIP_TOLERANCE
                    ),
                    horizontalLoss,
                    verticalLoss,
                }
            })
            .filter(Boolean)

        const clipped = candidates
            .filter(candidate => candidate.clipped)
            .map(candidate => ({
                label: candidate.label,
                rect: rectSnapshot(candidate.rect),
                visibleRect: rectSnapshot(candidate.visibleRect),
                horizontalLoss: Math.round(candidate.horizontalLoss * 10) / 10,
                verticalLoss: Math.round(candidate.verticalLoss * 10) / 10,
            }))

        const overlaps = []
        for (let firstIndex = 0; firstIndex < candidates.length; firstIndex += 1) {
            const first = candidates[firstIndex]
            for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex += 1) {
                const second = candidates[secondIndex]
                if (first.element.contains(second.element) || second.element.contains(first.element)) continue

                const overlap = intersect(first.visibleRect, second.visibleRect)
                const overlapDimensions = dimensions(overlap)
                if (overlapDimensions.width <= OVERLAP_TOLERANCE || overlapDimensions.height <= OVERLAP_TOLERANCE) continue

                const overlapArea = overlapDimensions.width * overlapDimensions.height
                const firstArea = Math.max(1, dimensions(first.visibleRect).width * dimensions(first.visibleRect).height)
                const secondArea = Math.max(1, dimensions(second.visibleRect).width * dimensions(second.visibleRect).height)
                if (overlapArea < 16 || overlapArea / Math.min(firstArea, secondArea) < 0.12) continue

                overlaps.push({
                    first: first.label,
                    second: second.label,
                    overlap: rectSnapshot(overlap),
                })
            }
        }

        return { missingRoot: false, clipped, overlaps, count: candidates.length }
    }, { selector: rootSelector })
}

function assertVisibleCtaLayout(report, context) {
    assert.equal(report.missingRoot, false, `${context} is missing its CTA report root`)
    assert.deepEqual(
        report.clipped,
        [],
        `${context} has visible CTAs outside the viewport or a clipping ancestor:\n${JSON.stringify(report.clipped, null, 2)}`,
    )
    assert.deepEqual(
        report.overlaps,
        [],
        `${context} has overlapping visible CTAs:\n${JSON.stringify(report.overlaps, null, 2)}`,
    )
}

async function collectCompositionShellReport(page, route) {
    return page.evaluate(({ currentRoute }) => {
        const visibleRect = (selector, requiredPosition) => {
            for (const element of document.querySelectorAll(selector)) {
                const rect = element.getBoundingClientRect()
                const style = getComputedStyle(element)
                if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 1 || rect.height < 1) continue
                if (requiredPosition && style.position !== requiredPosition) continue
                return {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    width: rect.width,
                    height: rect.height,
                    position: style.position,
                }
            }
            return null
        }
        const actionSelector = currentRoute === '/advanced'
            ? '[data-testid="main-generate-action"]'
            : '[data-testid="scene-generate-action"], [data-testid="scene-cancel-action"]'
        const shellActions = new Set(document.querySelectorAll([
            '[data-testid="composition-command-bar"] button',
            '[data-testid="composition-mobile-command-dock"] button',
            '[data-testid="main-command-dock"] button',
            '[data-testid="composition-module-stack"] button',
            '[data-testid="composition-inspector"] button',
        ].join(',')))
        const shortActions = Array.from(shellActions).flatMap((element, index) => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 1 || rect.height < 1) return []
            if (rect.width >= 44 && rect.height >= 44) return []
            return [{
                label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 60) || `action-${index}`,
                width: rect.width,
                height: rect.height,
            }]
        })
        const commandBarElement = Array.from(document.querySelectorAll('[data-testid="composition-command-bar"]')).find(element => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1
        })
        const commandLabels = commandBarElement
            ? Array.from(commandBarElement.querySelectorAll('[data-command-label]')).map(element => getComputedStyle(element).whiteSpace)
            : []
        const visiblePromptGenerateActions = Array.from(document.querySelectorAll('[data-testid="prompt-generate-action"]')).filter(element => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1
        }).length

        return {
            layout: visibleRect('[data-testid="composition-workspace-layout"]'),
            promptDock: visibleRect('#nai-blue-prompt-dock'),
            dock: visibleRect('[data-testid="composition-mobile-command-dock"], [data-testid="main-command-dock"]', 'fixed'),
            commandBar: visibleRect('[data-testid="composition-command-bar"]'),
            moduleTrigger: visibleRect('[data-testid="composition-command-bar"] [data-testid="composition-open-modules"]'),
            inspectorTrigger: visibleRect('[data-testid="composition-command-bar"] [data-testid="composition-open-inspector"]'),
            moduleStack: visibleRect('[data-testid="composition-module-stack"]'),
            canvas: visibleRect('[data-testid="composition-workspace-canvas"]'),
            inspector: visibleRect('[data-testid="composition-inspector"]'),
            action: visibleRect(actionSelector),
            shortActions,
            commandBarRadius: commandBarElement ? getComputedStyle(commandBarElement).borderRadius : null,
            commandLabels,
            visiblePromptGenerateActions,
            dockGroupCount: document.querySelectorAll([
                '[data-testid="main-command-dock"] [data-testid="composition-mobile-settings"]',
                '[data-testid="main-command-dock"] [data-testid="composition-mobile-count"]',
                '[data-testid="main-command-dock"] [data-command-group="primary"]',
            ].join(',')).length,
        }
    }, { currentRoute: route })
}

function assertCompositionShell(report, route, viewport) {
    const context = `${route} composition shell @ ${viewport.width}x${viewport.height}`
    assert.ok(report.layout, `${context} is missing the workspace layout`)
    assert.ok(report.action, `${context} is missing Generate/Cancel`)
    assert.ok(
        report.action.width >= 44 && report.action.height >= 44,
        `${context} Generate/Cancel is below 44px (${report.action.width}x${report.action.height})`,
    )
    assert.deepEqual(report.shortActions, [], `${context} has Composition actions below 44px: ${JSON.stringify(report.shortActions)}`)
    assert.equal(report.visiblePromptGenerateActions, route === '/advanced' ? 0 : report.visiblePromptGenerateActions, `${context} duplicates the Advanced generation CTA inside Prompt`)

    if (viewport.mobile) {
        assert.ok(report.dock, `${context} must show the mobile command dock`)
        assert.equal(report.commandBar, null, `${context} must keep the desktop/tablet command bar hidden`)
        assert.equal(report.dock.position, 'fixed', `${context} mobile dock must be fixed`)
        assert.ok(report.dock.left >= -1 && report.dock.right <= viewport.width + 1, `${context} dock leaves the horizontal viewport`)
        assert.ok(report.dock.bottom <= viewport.height + 1, `${context} dock leaves the bottom viewport`)
        assert.ok(
            report.action.top >= report.dock.top - 1 && report.action.bottom <= report.dock.bottom + 1,
            `${context} Generate/Cancel is not inside the dock`,
        )
        if (route === '/advanced') {
            assert.equal(report.dockGroupCount, 3, `${context} must expose exactly Settings, quantity, and Generate groups`)
        }
        return
    }

    assert.equal(report.dock, null, `${context} must hide the mobile command dock at tablet/desktop widths`)
    assert.ok(report.commandBar, `${context} must show the composition command bar`)
    assert.equal(report.commandBarRadius, '0px', `${context} command rail must not regain panel radius`)
    assert.ok(report.commandLabels.every(value => value === 'nowrap'), `${context} command labels must stay on one line: ${JSON.stringify(report.commandLabels)}`)

    if (viewport.width >= 1536) {
        if (route === '/advanced') {
            assert.ok(report.promptDock, `${context} must keep the Prompt rail visible`)
            assert.equal(report.moduleStack, null, `${context} keeps Module Stack behind its explicit action to preserve canvas width`)
            assert.equal(report.inspector, null, `${context} keeps Context Inspector behind its explicit action to preserve canvas width`)
            // Direct mode has no recipe/module action. Once module content exists,
            // the single Module Stack action is the entry point and selecting an
            // item advances to the Inspector sheet.
            if (report.moduleTrigger) {
                assert.ok(
                    report.moduleTrigger.width >= 44 && report.moduleTrigger.height >= 44,
                    `${context} Module Stack action is below 44px (${report.moduleTrigger.width}x${report.moduleTrigger.height})`,
                )
            }
            assert.equal(report.inspectorTrigger, null, `${context} must keep the simplified command bar free of a duplicate Inspector action`)
            assert.ok(report.canvas, `${context} must show the center canvas/grid`)
            assert.ok(report.promptDock.right <= report.canvas.left + 24, `${context} must preserve Prompt rail → canvas ordering`)
            return
        }
        if (route === '/scenes') {
            // The public Scene workflow deliberately hides internal composition
            // panels while preserving the prompt, canvas, and generation loop.
            assert.ok(report.promptDock, `${context} must keep the Prompt rail visible`)
            assert.equal(report.moduleStack, null, `${context} must hide the internal Module Stack`)
            assert.equal(report.inspector, null, `${context} must hide the internal Context Inspector`)
            assert.equal(report.moduleTrigger, null, `${context} must hide the internal Module Stack action`)
            assert.equal(report.inspectorTrigger, null, `${context} must hide the internal Context Inspector action`)
            assert.ok(report.canvas, `${context} must show the center scene grid`)
            assert.ok(report.promptDock.right <= report.canvas.left + 24, `${context} must preserve Prompt rail → scene grid ordering`)
            return
        }
        assert.ok(report.moduleStack, `${context} must show the Module Stack rail`)
        assert.ok(report.canvas, `${context} must show the center canvas/grid`)
        assert.ok(report.inspector, `${context} must show the Context Inspector rail`)
        assert.ok(
            report.moduleStack.right <= report.canvas.left + 1 && report.canvas.right <= report.inspector.left + 1,
            `${context} does not preserve Module Stack → canvas/grid → Inspector ordering`,
        )
    }
}

async function collectText200OverflowReport(page) {
    return page.evaluate(async () => {
        const previousFontSize = document.documentElement.style.fontSize
        document.documentElement.style.fontSize = '200%'
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const main = document.querySelector('main')
        const workspace = document.querySelector('[data-testid="composition-workspace-layout"]')
        const report = {
            bodyScrollWidth: document.body.scrollWidth,
            documentWidth: document.documentElement.clientWidth,
            mainScrollWidth: main?.scrollWidth ?? 0,
            mainClientWidth: main?.clientWidth ?? 0,
            workspaceScrollWidth: workspace?.scrollWidth ?? 0,
            workspaceClientWidth: workspace?.clientWidth ?? 0,
        }
        document.documentElement.style.fontSize = previousFontSize
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return report
    })
}

// R2 contains user-controlled paths and long Korean action labels. Global
// overflow checks cannot detect a flex/grid column that stays inside the page
// while collapsing its text to one character per line, so this report also
// rejects pathologically narrow multi-line text at normal and 200% text size.
async function collectR2ReadabilityReport(page, enlargedText) {
    return page.evaluate(async enlarged => {
        const previousFontSize = document.documentElement.style.fontSize
        if (enlarged) document.documentElement.style.fontSize = '200%'
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

        const root = document.querySelector('[data-testid="native-r2-guided-setup"]')
        const visible = element => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1
        }
        const pathologicalTextColumns = root
            ? Array.from(root.querySelectorAll('*')).flatMap((element, index) => {
                if (!visible(element) || element.matches('input, option, script, style')) return []
                const directText = Array.from(element.childNodes)
                    .filter(node => node.nodeType === Node.TEXT_NODE)
                    .map(node => node.textContent ?? '')
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                if (directText.length < 8) return []
                const rect = element.getBoundingClientRect()
                const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 16
                return rect.width < 80 && rect.height > lineHeight * 4
                    ? [{ index, text: directText.slice(0, 80), width: rect.width, height: rect.height, lineHeight }]
                    : []
            })
            : []
        const trackedText = root
            ? Array.from(root.querySelectorAll('[data-r2-readable-text]')).filter(visible).map(element => {
                const rect = element.getBoundingClientRect()
                return {
                    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
                    width: rect.width,
                    height: rect.height,
                    scrollWidth: element.scrollWidth,
                    clientWidth: element.clientWidth,
                }
            })
            : []
        const actionOverflow = root
            ? Array.from(root.querySelectorAll('button')).filter(visible).flatMap(button => (
                button.scrollWidth > button.clientWidth + 1
                    ? [{ text: (button.textContent ?? '').trim().slice(0, 80), scrollWidth: button.scrollWidth, clientWidth: button.clientWidth }]
                    : []
            ))
            : []

        const report = {
            missingRoot: !root,
            stepCount: root?.querySelectorAll('ol > li').length ?? 0,
            guideCount: root?.querySelectorAll('ol > li > aside').length ?? 0,
            pathologicalTextColumns,
            trackedText,
            actionOverflow,
        }
        document.documentElement.style.fontSize = previousFontSize
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return report
    }, enlargedText)
}

function assertR2Readability(report, context) {
    assert.equal(report.missingRoot, false, `${context} is missing the R2 setup root`)
    assert.equal(report.stepCount, 2, `${context} must show exactly the current two R2 workflow steps`)
    assert.equal(report.guideCount, 2, `${context} must keep one guide beside each visible R2 step`)
    assert.deepEqual(report.pathologicalTextColumns, [], `${context} collapses text into a vertical column: ${JSON.stringify(report.pathologicalTextColumns)}`)
    assert.deepEqual(report.actionOverflow, [], `${context} has action text outside its button: ${JSON.stringify(report.actionOverflow)}`)
    for (const tracked of report.trackedText) {
        assert.ok(tracked.width >= 120, `${context} makes tracked text too narrow: ${JSON.stringify(tracked)}`)
        assert.ok(tracked.scrollWidth <= tracked.clientWidth + 1, `${context} overflows tracked text: ${JSON.stringify(tracked)}`)
    }
}

async function collectCompositionQualityReport(page, rootSelector, coarsePointer) {
    return page.evaluate(({ selector, coarse }) => {
        const root = document.querySelector(selector)
        if (!root) return { missingRoot: true }
        const visible = element => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1
        }
        const accessibleName = element => {
            const labelledBy = element.getAttribute('aria-labelledby')
            const labelledText = labelledBy
                ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
                : ''
            const label = element instanceof HTMLElement && element.id
                ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent ?? ''
                : ''
            return [
                element.getAttribute('aria-label'),
                labelledText,
                element.getAttribute('title'),
                label,
                element.textContent,
                element.getAttribute('alt'),
                element.getAttribute('value'),
            ].filter(Boolean).join(' ').trim()
        }
        const interactives = Array.from(root.querySelectorAll([
            'button',
            'a[href]',
            'input:not([type="hidden"])',
            'select',
            'textarea',
            '[role="button"]',
            '[role="tab"]',
            '[tabindex]:not([tabindex="-1"])',
        ].join(','))).filter(visible)
        const coarseTargetsBelow44 = coarse ? interactives.flatMap((element, index) => {
            const rect = element.getBoundingClientRect()
            return rect.width + 0.5 < 44 || rect.height + 0.5 < 44
                ? [{ name: accessibleName(element) || `interactive-${index}`, width: rect.width, height: rect.height }]
                : []
        }) : []
        const iconOnlyMissingNames = interactives.flatMap((element, index) => {
            const visibleText = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
            const iconOnly = visibleText.length === 0 && Boolean(element.querySelector('svg, img'))
            return iconOnly && accessibleName(element).length === 0
                ? [{ element: element.tagName.toLowerCase(), index }]
                : []
        })

        const cardSelector = '[data-slot="card"], .border.bg-card, .bg-card.border'
        let maxNestedCardDepth = 0
        for (const card of root.querySelectorAll(cardSelector)) {
            if (!visible(card)) continue
            let depth = 1
            for (let parent = card.parentElement; parent && parent !== root; parent = parent.parentElement) {
                if (parent.matches(cardSelector)) depth += 1
            }
            maxNestedCardDepth = Math.max(maxNestedCardDepth, depth)
        }

        const textOutsideContainer = Array.from(root.querySelectorAll('*')).flatMap((element, index) => {
            if (!visible(element) || element.matches('input, textarea, pre, code, option, script, style')) return []
            if (element.closest('[data-intentional-editor-scroll], .overflow-x-auto, .overflow-x-scroll')) return []
            const hasDirectText = Array.from(element.childNodes).some(node => (
                node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
            ))
            if (!hasDirectText || element.clientWidth < 1) return []
            const style = getComputedStyle(element)
            if ((style.overflowX === 'hidden' || style.overflowX === 'clip') && style.whiteSpace === 'nowrap') return []
            return element.scrollWidth > element.clientWidth + 1
                ? [{ index, text: (element.textContent ?? '').trim().slice(0, 80), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }]
                : []
        })

        const focusRingClipped = interactives.flatMap((element, index) => {
            if (!(element instanceof HTMLElement) || !element.className?.toString().includes('focus-visible:')) return []
            const rect = element.getBoundingClientRect()
            const margin = 3
            for (let parent = element.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
                const style = getComputedStyle(parent)
                const clipsX = ['hidden', 'clip'].includes(style.overflowX)
                const clipsY = ['hidden', 'clip'].includes(style.overflowY)
                if (!clipsX && !clipsY) continue
                const parentRect = parent.getBoundingClientRect()
                if ((clipsX && (rect.left - margin < parentRect.left || rect.right + margin > parentRect.right)) ||
                    (clipsY && (rect.top - margin < parentRect.top || rect.bottom + margin > parentRect.bottom))) {
                    return [{
                        name: accessibleName(element) || `interactive-${index}`,
                        clipsX,
                        clipsY,
                        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                        parent: { left: parentRect.left, right: parentRect.right, top: parentRect.top, bottom: parentRect.bottom, className: parent.className?.toString().slice(0, 120) },
                    }]
                }
            }
            return []
        })

        const dock = root.querySelector('[data-testid="composition-mobile-command-dock"], [data-testid="main-command-dock"]')
        const dockStyle = dock ? getComputedStyle(dock) : null
        const fixedCtaSafeInset = !dock || dockStyle?.position !== 'fixed'
            ? true
            : Number.parseFloat(dockStyle.paddingBottom || '0') >= 0 && dock.getBoundingClientRect().bottom <= innerHeight + 1

        return {
            missingRoot: false,
            coarseTargetsBelow44,
            iconOnlyMissingNames,
            focusRingClipped,
            fixedCtaSafeInset,
            maxNestedCardDepth,
            textOutsideContainer,
        }
    }, { selector: rootSelector, coarse: coarsePointer })
}

function assertCompositionQuality(report, context) {
    assert.equal(report.missingRoot, false, `${context} is missing its composition quality root`)
    assert.deepEqual(report.coarseTargetsBelow44, [], `${context} has coarse-pointer targets below 44x44: ${JSON.stringify(report.coarseTargetsBelow44)}`)
    assert.deepEqual(report.iconOnlyMissingNames, [], `${context} has icon-only actions without accessible names`)
    assert.deepEqual(report.focusRingClipped, [], `${context} has focus rings clipped by a non-scroll container: ${JSON.stringify(report.focusRingClipped)}`)
    assert.equal(report.fixedCtaSafeInset, true, `${context} fixed CTA overlaps or leaves the system-bar-safe viewport`)
    assert.ok(report.maxNestedCardDepth <= 3, `${context} has excessive nested card depth ${report.maxNestedCardDepth}`)
    assert.deepEqual(report.textOutsideContainer, [], `${context} has text outside its container: ${JSON.stringify(report.textOutsideContainer)}`)
}

async function assertGuidedSingleMilestoneContract(page, viewport) {
    await page.locator('[data-guided-choice="single"]').click()
    await page.waitForURL(/\/guided-preview\/work\/[^/]+\/prompt$/)
    await page.locator('[data-testid="guided-single-progress"]').waitFor({ state: 'visible' })
    const collectProgress = () => page.evaluate(() => {
        const progress = document.querySelector('[data-testid="guided-single-progress"]')
        return {
            text: progress?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            horizontalStepNavigationCount: document.querySelectorAll('[data-testid="guided-single-progress"] ol').length,
        }
    })
    const report = await collectProgress()

    assert.match(report.text, /1\s*\/\s*4/, `Guided single-image progress must start at fixed 1 / 4 @ ${viewport.width}px`)
    assert.equal(report.horizontalStepNavigationCount, 0, `Guided single-image must not duplicate progress with horizontal step navigation @ ${viewport.width}px`)
    if (evidenceDir) {
        await page.screenshot({ path: path.join(evidenceDir, `guided-single-${viewport.width}.png`), animations: 'disabled' })
    }

    await page.locator('textarea').first().fill('1girl, blue hair')
    await page.locator('footer button').last().click()
    await page.waitForURL(/\/resolution$/)
    await page.waitForFunction(() => document.querySelector('[data-testid="guided-single-progress"]')?.textContent?.includes('2 / 4'))

    await page.locator('footer button').last().click()
    await page.waitForURL(/\/output$/)
    await page.waitForFunction(() => document.querySelector('[data-testid="guided-single-progress"]')?.textContent?.includes('3 / 4'))

    await page.locator('footer button').last().click()
    await page.waitForURL(/\/review$/)
    await page.waitForFunction(() => document.querySelector('[data-testid="guided-single-progress"]')?.textContent?.includes('4 / 4'))
    if (evidenceDir) {
        await page.screenshot({ path: path.join(evidenceDir, `guided-review-${viewport.width}.png`), animations: 'disabled' })
    }
}

async function assertCompositionSheetFocusReturn(page, route, viewport) {
    const dock = page.locator('[data-testid="composition-mobile-command-dock"], [data-testid="main-command-dock"]')
    const trigger = dock.locator(route === '/advanced'
        ? '[data-testid="composition-mobile-settings"]'
        : '[data-testid="composition-open-modules"]')
    const sheetTestId = route === '/advanced' ? 'main-module-stack-sheet' : 'scene-modules-sheet'
    const sheet = page.locator(`[data-testid="${sheetTestId}"]`)

    // Direct mode intentionally omits the module action until a recipe or
    // module exists. Exercise the focus contract when the action is available
    // without mistaking the primary Generate button for it.
    if (await trigger.count() === 0 || !await trigger.isVisible()) return

    await trigger.focus()
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true, `${route} module trigger did not receive focus`)
    await trigger.click()
    await sheet.waitFor({ state: 'visible' })
    assert.equal(
        await sheet.evaluate(element => element.contains(document.activeElement)),
        true,
        `${route} composition sheet did not trap initial focus @ ${viewport.width}px`,
    )
    await page.keyboard.press('Tab')
    assert.equal(
        await sheet.evaluate(element => element.contains(document.activeElement)),
        true,
        `${route} composition sheet allowed focus to escape @ ${viewport.width}px`,
    )
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'hidden' })
    const triggerHandle = await trigger.elementHandle()
    await page.waitForFunction(
        element => element === document.activeElement,
        triggerHandle,
        { timeout: 2_000 },
    )
    assert.equal(
        await trigger.evaluate(element => element === document.activeElement),
        true,
        `${route} composition sheet did not return focus @ ${viewport.width}px`,
    )
}

async function assertWideCompositionPanelAccess(page, route, viewport) {
    const panels = route === '/advanced'
        ? [
            { triggerId: 'composition-open-modules', sheetId: 'main-module-stack-sheet', name: 'Module Stack' },
            { triggerId: 'composition-open-inspector', sheetId: 'main-composition-inspector-sheet', name: 'Context Inspector' },
        ]
        : [
            { triggerId: 'composition-open-modules', sheetId: 'scene-modules-sheet', name: 'Module Stack' },
            { triggerId: 'composition-open-inspector', sheetId: 'scene-inspector-sheet', name: 'Scene inspector' },
        ]

    for (const panel of panels) {
        const trigger = page.locator(`[data-testid="composition-command-bar"] [data-testid="${panel.triggerId}"]`)
        const sheet = page.locator(`[data-testid="${panel.sheetId}"]`)
        if (await trigger.count() === 0 || !await trigger.isVisible()) continue
        await trigger.focus()
        await trigger.click()
        await sheet.waitFor({ state: 'visible' })
        assert.equal(
            await sheet.evaluate(element => element.contains(document.activeElement)),
            true,
            `${route} ${panel.name} did not receive focus @ ${viewport.width}px`,
        )
        await page.keyboard.press('Escape')
        await sheet.waitFor({ state: 'hidden' })
        const triggerHandle = await trigger.elementHandle()
        await page.waitForFunction(
            element => element === document.activeElement,
            triggerHandle,
            { timeout: 2_000 },
        )
    }
}

async function assertWideCompositionCoreLoop(page, route, viewport) {
    const context = `${route} core loop @ ${viewport.width}x${viewport.height}`
    const promptDock = page.locator('#nai-blue-prompt-dock')
    const promptEditor = promptDock.locator('[data-testid="prompt-editor-surface"] textarea')
    const workspaceSelector = route === '/advanced'
        ? '[data-testid="main-result-canvas"]'
        : '[data-testid="scene-grid-workspace"]'
    const workspace = page.locator(workspaceSelector)

    await promptDock.waitFor({ state: 'visible' })
    await promptEditor.waitFor({ state: 'visible' })
    await workspace.waitFor({ state: 'visible' })
    assert.equal(await promptEditor.isEditable(), true, `${context} prompt editor is not editable`)

    // PromptEditorSurface feeds only the draft store; a one-character local edit
    // proves the shared dock is usable without invoking its separate provider or
    // output commands. Restoring the initial draft prevents this smoke from
    // leaving authored input behind for either composition route.
    const initialValue = await promptEditor.inputValue()
    const smokeValue = initialValue === 'x' ? 'y' : 'x'
    await promptEditor.fill(smokeValue)
    assert.equal(await promptEditor.inputValue(), smokeValue, `${context} prompt editor did not accept local input`)

    const visibility = await page.evaluate((targetSelector) => {
        const visibleInViewport = selector => {
            const element = document.querySelector(selector)
            if (!element) return false
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                rect.width > 1 &&
                rect.height > 1 &&
                rect.right > 0 &&
                rect.left < window.innerWidth &&
                rect.bottom > 0 &&
                rect.top < window.innerHeight
        }

        return {
            promptDock: visibleInViewport('#nai-blue-prompt-dock'),
            workspace: visibleInViewport(targetSelector),
        }
    }, workspaceSelector)
    assert.equal(visibility.promptDock, true, `${context} hides the Prompt dock after editing`)
    assert.equal(visibility.workspace, true, `${context} hides the result workspace after editing`)

    await promptEditor.fill(initialValue)
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

    while (Date.now() - started < 30000) {
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
        new Promise(resolve => setTimeout(resolve, 3000)),
    ])
}

async function closeBrowser(browser) {
    let timeoutId
    const timeout = new Promise(resolve => {
        timeoutId = setTimeout(() => {
            console.warn('Chromium cleanup exceeded 5 seconds; forcing test process shutdown')
            resolve()
        }, 5000)
    })
    await Promise.race([
        browser.close().catch(error => {
            console.warn(`Chromium cleanup failed: ${error.message}`)
        }),
        timeout,
    ])
    clearTimeout(timeoutId)
}

async function main() {
    // Reuse a prepared preview when supplied, which also supports restricted runners that cannot bind a port.
    const server = process.env.RESPONSIVE_CONTRACT_URL
        ? null
        : run(npmCommand, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'])

    try {
        if (server) await waitForReady(server)

        const browser = await chromium.launch()
        try {
            for (const viewport of VIEWPORTS) {
                const page = await browser.newPage({
                    viewport: { width: viewport.width, height: viewport.height },
                    hasTouch: Boolean(viewport.mobile),
                    isMobile: Boolean(viewport.mobile),
                })
                page.setDefaultTimeout(20_000)
                await page.route('**/*', route => {
                    const requestUrl = route.request().url()
                    if (requestUrl.startsWith(baseUrl) || !/^https?:/i.test(requestUrl)) {
                        return route.continue()
                    }
                    return route.abort()
                })
                const viewportRoutes = viewport.width === 1536
                    ? WIDE_COMPOSITION_ROUTES.filter(route => routes.includes(route))
                    : routes
                for (const route of viewportRoutes) {
                    console.log(`Checking ${route} at ${viewport.width}x${viewport.height}`)
                    await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' })
                    await page.waitForFunction(() => {
                        const main = document.querySelector('main')
                        return Boolean(
                            main?.querySelector(
                                'a, button, input, textarea, [role="tab"], [data-testid]',
                            ),
                        )
                    })
                    await page.evaluate(async () => {
                        // Hosted runners may not reach the external font CDNs.
                        // Bound that optional wait and validate the system-font
                        // fallback layout instead of stalling the release gate.
                        await Promise.race([
                            document.fonts?.ready ?? Promise.resolve(),
                            new Promise(resolve => setTimeout(resolve, 750)),
                        ])
                        await new Promise(resolve => {
                            requestAnimationFrame(() => requestAnimationFrame(resolve))
                        })
                    })
                    if (route === '/style-lab') {
                        if (viewport.width < 640) await page.locator('select').filter({ has: page.locator('option[value="settings"]') }).selectOption('settings')
                        else await page.locator('[role="tab"]').last().click()
                    }

                    const report = await page.evaluate(() => {
                        const main = document.querySelector('main')
                        const centerPanel = main?.parentElement
                        const asides = Array.from(document.querySelectorAll('#nai-blue-prompt-dock, #nai-blue-history-dock')).map((aside) => {
                            const rect = aside.getBoundingClientRect()
                            const style = getComputedStyle(aside)
                            return {
                                width: rect.width,
                                display: style.display,
                                visible: style.display !== 'none' && rect.width > 1 && rect.height > 1,
                            }
                        })
                        const visibleTextareas = Array.from(document.querySelectorAll('textarea'))
                            .filter((textarea) => {
                                const rect = textarea.getBoundingClientRect()
                                const style = getComputedStyle(textarea)
                                return style.display !== 'none' && rect.width > 1 && rect.height > 1
                            })
                            .map((textarea) => {
                                const rect = textarea.getBoundingClientRect()
                                const style = getComputedStyle(textarea)
                                return {
                                    width: rect.width,
                                    height: rect.height,
                                    fontSize: Number.parseFloat(style.fontSize),
                                    scrollWidth: textarea.scrollWidth,
                                    clientWidth: textarea.clientWidth,
                                }
                            })

                        const navTargets = Array.from(document.querySelectorAll(document.querySelector('.workspace-shell')
                            ? '.fb-app-navigation a' : 'nav a, nav button'))
                            .filter((target) => {
                                const rect = target.getBoundingClientRect()
                                const style = getComputedStyle(target)
                                return style.display !== 'none' && rect.width > 1 && rect.height > 1
                            })
                            .map((target) => {
                                const rect = target.getBoundingClientRect()
                                return { width: rect.width, height: rect.height }
                            })

                        const mainRect = main?.getBoundingClientRect()
                        const mainDock = document.querySelector('[data-testid="main-command-dock"]')
                        const mainAction = document.querySelector('[data-testid="main-generate-action"]')
                        const dockRect = mainDock?.getBoundingClientRect()
                        const actionRect = mainAction?.getBoundingClientRect()

                        return {
                            bodyScrollWidth: document.body.scrollWidth,
                            documentWidth: document.documentElement.clientWidth,
                            mainScrollWidth: main?.scrollWidth ?? 0,
                            mainClientWidth: main?.clientWidth ?? 0,
                            mainWithinViewport: !mainRect || (mainRect.left >= -1 && mainRect.right <= window.innerWidth + 1),
                            centerWidth: centerPanel?.getBoundingClientRect().width ?? 0,
                            visibleSidebarCount: asides.filter(aside => aside.visible).length,
                            textareas: visibleTextareas,
                            navTargets,
                            mainDock: dockRect && actionRect ? {
                                bottom: dockRect.bottom,
                                actionHeight: actionRect.height,
                            } : null,
                        }
                    })
                    const ctaReport = await collectVisibleCtaReport(page)

                    assert.ok(
                        report.centerWidth >= viewport.minCenterWidth,
                        `${route} @ ${viewport.width}px center panel is ${report.centerWidth}px; expected at least ${viewport.minCenterWidth}px`,
                    )
                    assert.ok(
                        report.bodyScrollWidth <= report.documentWidth + 1,
                        `${route} @ ${viewport.width}px creates page-level horizontal overflow`,
                    )
                    assert.ok(
                        report.mainScrollWidth <= report.mainClientWidth + 1,
                        `${route} @ ${viewport.width}px creates main-region horizontal overflow (${report.mainScrollWidth}px > ${report.mainClientWidth}px)`,
                    )
                    assert.ok(report.mainWithinViewport, `${route} @ ${viewport.width}px main region leaves the viewport`)
                    assertVisibleCtaLayout(ctaReport, `${route} @ ${viewport.width}px`)

                    // The workbench names two destinations; Tools and theme are adjacent header controls.
                    // Every specialist category now shares the same labelled primary navigation.
                    if (route !== '/guided-preview') {
                        assert.ok(report.navTargets.length >= 2, `${route} @ ${viewport.width}px should expose primary navigation`)
                        for (const [index, target] of report.navTargets.entries()) {
                            assert.ok(
                                target.width >= 40 && target.height >= 40,
                                `${route} @ ${viewport.width}px nav target ${index} is too small (${target.width}x${target.height})`,
                            )
                        }
                    }

                    if (route === '/folders') {
                        // Match the named controls in the browser's current locale without changing other routes' language.
                        const labels = await page.evaluate(async () => {
                            const { default: i18n } = await import('/src/i18n/index.ts')
                            return Object.fromEntries([
                                'navigation.label', 'navigation.tools', 'design.navCreate', 'design.navHistory',
                                'design.toLight', 'design.toDark', 'design.light', 'design.dark', 'design.folders', 'design.findFolder',
                            ].map(key => [key, i18n.t(`folderWorkbench.${key}`)]))
                        })
                        const navigation = page.getByRole('navigation', { name: labels['navigation.label'], exact: true })
                        const create = navigation.getByRole('link', { name: labels['design.navCreate'], exact: true })
                        const history = navigation.getByRole('link', { name: labels['design.navHistory'], exact: true })
                        assert.equal(await create.getAttribute('href'), '/folders')
                        assert.equal(await create.getAttribute('aria-current'), 'page')
                        assert.equal(await history.getAttribute('href'), '/queue')
                        const header = page.locator('.fb-app-header')
                        const tools = header.getByRole('button', { name: labels['navigation.tools'], exact: true })
                        const theme = header.getByRole('button', { name: labels['design.toLight'], exact: true })
                            .or(header.getByRole('button', { name: labels['design.toDark'], exact: true }))
                        for (const control of [create, history, tools, theme]) {
                            assert.equal(await control.isVisible(), true, 'Workbench header controls must always be visible')
                            const box = await control.boundingBox()
                            assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= -1 && box.x + box.width <= viewport.width + 1 && box.y >= -1 && box.y + box.height <= viewport.height + 1, 'Workbench header controls must fit the viewport with 44px targets')
                            assert.ok(await control.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize) >= 16), 'Workbench primary controls need 16px text')
                        }
                        assert.ok([labels['design.light'], labels['design.dark']].includes((await theme.innerText()).trim()))
                        const sidebar = page.locator('.fb-sidebar')
                        assert.equal(await sidebar.isVisible(), viewport.width >= 1024, 'Workbench folder rail must switch to a drawer below desktop width')
                        if (viewport.width < 1024) {
                            await page.getByRole('button', { name: labels['design.folders'], exact: true }).click()
                            const drawer = page.getByRole('dialog', { name: labels['design.folders'], exact: true })
                            await drawer.waitFor({ state: 'visible' })
                            assert.equal(await drawer.getByLabel(labels['design.findFolder'], { exact: true }).isVisible(), true)
                            await page.keyboard.press('Escape')
                            await drawer.waitFor({ state: 'hidden' })
                        }
                        await tools.focus()
                        await page.keyboard.press('Enter')
                        const menu = page.getByRole('menu')
                        await menu.waitFor({ state: 'visible' })
                        for (const destination of defaultRoutes.filter(value => !['/folders', '/queue', '/guided-preview'].includes(value))) {
                            const link = menu.locator(`a[href="${destination}"]`)
                            assert.equal(await link.count(), 1, `Workbench tools must expose ${destination}`)
                            assert.ok((await link.innerText()).trim(), `Workbench ${destination} link must have an accessible name`)
                            const bounds = await link.boundingBox()
                            assert.ok(bounds && bounds.width >= 40 && bounds.height >= 40, `Workbench ${destination} target must be at least 40px`)
                        }
                        await page.keyboard.press('Escape')
                        await menu.waitFor({ state: 'hidden' })
                        await page.waitForFunction(() => document.activeElement?.matches('.fb-app-header button[aria-haspopup="menu"]'), undefined, { timeout: 2000 })
                    }

                    if (viewport.sidebars === 'hidden') {
                        assert.equal(
                            report.visibleSidebarCount,
                            0,
                            `${route} @ ${viewport.width}px should keep sidebars out of the primary frame`,
                        )
                    }

                    if (route === '/advanced' || route === '/scenes') {
                        const compositionActionSelector = route === '/advanced'
                            ? '[data-testid="main-generate-action"]'
                            : '[data-testid="scene-generate-action"], [data-testid="scene-cancel-action"]'
                        await page.waitForFunction(selector => Array.from(document.querySelectorAll(selector)).some(element => {
                            const rect = element.getBoundingClientRect()
                            const style = getComputedStyle(element)
                            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width >= 1 && rect.height >= 1
                        }), compositionActionSelector)
                        const compositionReport = await collectCompositionShellReport(page, route)
                        assertCompositionShell(compositionReport, route, viewport)
                        assertCompositionQuality(
                            await collectCompositionQualityReport(
                                page,
                                '[data-testid="composition-workspace-layout"]',
                                Boolean(viewport.mobile),
                            ),
                            `${route} composition quality @ ${viewport.width}px`,
                        )

                        const text200Report = await collectText200OverflowReport(page)
                        assert.ok(
                            text200Report.bodyScrollWidth <= text200Report.documentWidth + 1,
                            `${route} @ ${viewport.width}px creates page overflow at 200% text`,
                        )
                        assert.ok(
                            text200Report.mainScrollWidth <= text200Report.mainClientWidth + 1,
                            `${route} @ ${viewport.width}px creates main overflow at 200% text`,
                        )
                        // Optional composition panels are checked when the current recipe
                        // exposes their triggers; direct mode may correctly show Generate only.
                        if (viewport.width === 390 && route === '/advanced') {
                            await assertCompositionSheetFocusReturn(page, route, viewport)
                        }
                        if (viewport.width === 1536) {
                            await assertWideCompositionCoreLoop(page, route, viewport)
                            if (route === '/advanced') {
                                await assertWideCompositionPanelAccess(page, route, viewport)
                                const promptSurfaceGeometry = await page.locator('[data-testid="prompt-editor-surface"]').first().evaluate((surface) => {
                                    const editor = surface.querySelector('.prompt-editor-wrapper')
                                    const surfaceRect = surface.getBoundingClientRect()
                                    const editorRect = editor?.getBoundingClientRect()
                                    return {
                                        surfaceBottom: surfaceRect.bottom,
                                        editorBottom: editorRect?.bottom ?? Number.POSITIVE_INFINITY,
                                    }
                                })
                                assert.ok(
                                    promptSurfaceGeometry.editorBottom <= promptSurfaceGeometry.surfaceBottom + 1,
                                    'Wide prompt editor escapes its surface vertically',
                                )
                            }
                        }
                    }

                    if (route === '/r2') {
                        assertR2Readability(
                            await collectR2ReadabilityReport(page, false),
                            `/r2 readability @ ${viewport.width}px`,
                        )
                        assertR2Readability(
                            await collectR2ReadabilityReport(page, true),
                            `/r2 readability at 200% text @ ${viewport.width}px`,
                        )
                        const text200Report = await collectText200OverflowReport(page)
                        assert.ok(
                            text200Report.bodyScrollWidth <= text200Report.documentWidth + 1,
                            `/r2 @ ${viewport.width}px creates page overflow at 200% text`,
                        )
                        assert.ok(
                            text200Report.mainScrollWidth <= text200Report.mainClientWidth + 1,
                            `/r2 @ ${viewport.width}px creates main overflow at 200% text`,
                        )
                    }

                    if (route === '/style-lab') {
                        assert.ok(report.textareas.length > 0, 'Style Lab should render text areas')
                        for (const [index, textarea] of report.textareas.entries()) {
                            assert.ok(
                                textarea.width >= Math.min(300, viewport.width - 48),
                                `/style-lab @ ${viewport.width}px textarea ${index} is too narrow (${textarea.width}px)`,
                            )
                            assert.ok(
                                textarea.fontSize >= 12,
                                `/style-lab @ ${viewport.width}px textarea ${index} font is too small (${textarea.fontSize}px)`,
                            )
                            assert.ok(
                                textarea.scrollWidth <= textarea.clientWidth + 24,
                                `/style-lab @ ${viewport.width}px textarea ${index} has excessive horizontal internal overflow`,
                            )
                        }
                    }

                    // Optional evidence mode keeps the contract test fast by
                    // default while producing deterministic review artifacts
                    // when RESPONSIVE_EVIDENCE_DIR is supplied in CI or QA.
                    if (evidenceDir) {
                        await page.screenshot({
                            path: path.join(evidenceDir, `${routeSlug(route)}-${viewport.width}.png`),
                            animations: 'disabled',
                        })
                    }

                    if (route === '/guided-preview' && viewport.width === 390) {
                        await assertGuidedSingleMilestoneContract(page, viewport)
                    }

                    if (route === '/advanced') {
                        assert.ok(report.mainDock, `/ @ ${viewport.width}px should expose the compact generation dock`)
                        assert.ok(report.mainDock.bottom <= viewport.height + 1, `/ @ ${viewport.width}px command dock leaves the viewport`)
                        assert.ok(report.mainDock.actionHeight >= 44, `/ @ ${viewport.width}px generate action is below 44px`)

                        if (viewport.width === 390) {
                            await page.locator('.fb-app-tools').click()
                            await page.locator('[role="menuitem"][aria-controls="nai-blue-prompt-sheet"]').click()
                            const promptSheet = page.locator('#nai-blue-prompt-sheet')
                            await promptSheet.waitFor({ state: 'visible' })
                            const promptReport = await promptSheet.evaluate((sheet) => {
                                const actions = sheet.querySelectorAll('[data-testid="prompt-generate-action"]')
                                const surface = sheet.querySelector('[data-testid="prompt-editor-surface"]')
                                const editor = surface?.querySelector('.prompt-editor-wrapper')
                                const surfaceRect = surface?.getBoundingClientRect()
                                const editorRect = editor?.getBoundingClientRect()
                                return {
                                    scrollWidth: sheet.scrollWidth,
                                    clientWidth: sheet.clientWidth,
                                    actionCount: actions.length,
                                    tabWhiteSpace: Array.from(sheet.querySelectorAll('[role="tab"]')).map(tab => getComputedStyle(tab).whiteSpace),
                                    surfaceBottom: surfaceRect?.bottom ?? 0,
                                    editorBottom: editorRect?.bottom ?? Number.POSITIVE_INFINITY,
                                }
                            })
                            assert.ok(promptReport.scrollWidth <= promptReport.clientWidth + 1, 'Prompt Sheet has horizontal overflow')
                            assert.equal(promptReport.actionCount, 0, 'Prompt Sheet must not duplicate the Advanced generation CTA')
                            assert.ok(promptReport.tabWhiteSpace.every(value => value === 'nowrap'), `Prompt Sheet tab labels wrap: ${JSON.stringify(promptReport.tabWhiteSpace)}`)
                            assert.ok(promptReport.editorBottom <= promptReport.surfaceBottom + 1, 'Prompt editor escapes its surface vertically')
                            if (evidenceDir) {
                                await page.screenshot({ path: path.join(evidenceDir, 'prompt-sheet-390.png'), animations: 'disabled' })
                            }
                            await page.keyboard.press('Escape')
                            await promptSheet.waitFor({ state: 'hidden' })

                            await page.locator('.fb-app-tools').click()
                            await page.locator('[role="menuitem"][aria-controls="nai-blue-history-sheet"]').click()
                            const historySheet = page.locator('#nai-blue-history-sheet')
                            await historySheet.waitFor({ state: 'visible' })
                            const historyReport = await historySheet.evaluate((sheet) => {
                                const refresh = sheet.querySelector('[data-testid="history-refresh"]')
                                const queueActivity = sheet.querySelector('[data-testid="history-queue-activity"]')
                                const refreshRect = refresh?.getBoundingClientRect()
                                const queueActivityRect = queueActivity?.getBoundingClientRect()
                                const queueActivityStyle = queueActivity ? getComputedStyle(queueActivity) : null
                                return {
                                    scrollWidth: sheet.scrollWidth,
                                    clientWidth: sheet.clientWidth,
                                    refreshWidth: refreshRect?.width ?? 0,
                                    refreshHeight: refreshRect?.height ?? 0,
                                    queueActivityVisible: Boolean(
                                        queueActivityRect
                                        && queueActivityStyle
                                        && queueActivityStyle.display !== 'none'
                                        && queueActivityStyle.visibility !== 'hidden'
                                        && queueActivityRect.width > 1
                                        && queueActivityRect.height > 1
                                    ),
                                    queueActivityWidth: queueActivityRect?.width ?? 0,
                                    queueActivityHeight: queueActivityRect?.height ?? 0,
                                    queueActivityHref: queueActivity?.getAttribute('href') ?? '',
                                }
                            })
                            assert.ok(historyReport.scrollWidth <= historyReport.clientWidth + 1, 'History Sheet has horizontal overflow')
                            assert.ok(
                                historyReport.refreshWidth >= 44 && historyReport.refreshHeight >= 44,
                                `History refresh target is below 44px (${historyReport.refreshWidth}x${historyReport.refreshHeight})`,
                            )
                            // History owns the lightweight reservation summary; this link is
                            // the responsive handoff to Queue Center's detailed job controls.
                            assert.ok(historyReport.queueActivityVisible, 'History Sheet must expose reserved Queue activity')
                            assert.ok(
                                historyReport.queueActivityWidth >= 44 && historyReport.queueActivityHeight >= 44,
                                `History Queue activity target is below 44px (${historyReport.queueActivityWidth}x${historyReport.queueActivityHeight})`,
                            )
                            assert.equal(historyReport.queueActivityHref, '/queue', 'History Queue activity must open Queue Center')
                            if (evidenceDir) {
                                await page.screenshot({ path: path.join(evidenceDir, 'history-sheet-390.png'), animations: 'disabled' })
                            }
                            await historySheet.locator('[data-testid="history-queue-activity"]').click()
                            await page.waitForURL(url => url.pathname === '/queue')
                            await historySheet.waitFor({ state: 'hidden' })
                        }
                    }

                    if (route === '/web' && viewport.mobile) {
                        const addQuickLink = page.locator('main button:has(svg.lucide-plus)')
                        assert.equal(
                            await addQuickLink.count(),
                            1,
                            `/web @ ${viewport.width}px should expose one stable add-link dialog trigger`,
                        )
                        await addQuickLink.click()

                        const dialog = page.locator('[role="dialog"]')
                        await dialog.waitFor({ state: 'visible' })
                        const dialogReport = await dialog.evaluate((element) => {
                            const rect = element.getBoundingClientRect()
                            return {
                                left: rect.left,
                                top: rect.top,
                                right: rect.right,
                                bottom: rect.bottom,
                                scrollWidth: element.scrollWidth,
                                clientWidth: element.clientWidth,
                            }
                        })
                        assert.ok(
                            dialogReport.left >= -1 &&
                            dialogReport.top >= -1 &&
                            dialogReport.right <= viewport.width + 1 &&
                            dialogReport.bottom <= viewport.height + 1,
                            `/web @ ${viewport.width}px add-link dialog leaves the viewport: ${JSON.stringify(dialogReport)}`,
                        )
                        assert.ok(
                            dialogReport.scrollWidth <= dialogReport.clientWidth + 1,
                            `/web @ ${viewport.width}px add-link dialog has horizontal overflow`,
                        )
                        assertVisibleCtaLayout(
                            await collectVisibleCtaReport(page, '[role="dialog"]'),
                            `/web dialog @ ${viewport.width}px`,
                        )
                        if (evidenceDir) {
                            await page.screenshot({
                                path: path.join(evidenceDir, `web-dialog-${viewport.width}.png`),
                                animations: 'disabled',
                            })
                        }
                        await page.keyboard.press('Escape')
                        await dialog.waitFor({ state: 'hidden' })

                        // Quick-link delete controls only exist in edit mode.
                        // Exercise that state because coarse-pointer sizing can
                        // otherwise make them overlap the underlying link CTA.
                        const editQuickLinks = page.locator('main button:has(svg.lucide-square-pen)')
                        assert.equal(
                            await editQuickLinks.count(),
                            1,
                            `/web @ ${viewport.width}px should expose one stable quick-link edit trigger`,
                        )
                        await editQuickLinks.click()
                        await page.locator('main button:has(svg.lucide-x)').first().waitFor({ state: 'visible' })
                        assertVisibleCtaLayout(
                            await collectVisibleCtaReport(page),
                            `/web edit mode @ ${viewport.width}px`,
                        )
                    }
                }
                await page.close()
            }
            verifyDialogSourceContracts()
        } finally {
            await closeBrowser(browser)
        }
    } finally {
        await closeServer(server)
    }
}

main().then(
    () => process.exit(0),
    error => {
        console.error(error)
        process.exit(1)
    },
)
