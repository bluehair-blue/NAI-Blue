import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

describe('native R2 security and guided-setup contract', () => {
    it('keeps all ten setup decisions but renders them two at a time', async () => {
        const source = await readFile(`${ROOT}/src/components/r2/NativeR2SetupPanel.tsx`, 'utf8')
        for (let step = 1; step <= 10; step += 1) expect(source).toContain(`${step}. `)
        expect(source).toContain('const [setupPage, setSetupPage] = useState(0)')
        expect(source.match(/setupPage === [0-4]/g)).toHaveLength(7)
        expect(source).toContain("'단계 {{start}}–{{end}}', { start: setupPage * 2 + 1")
        expect(source).toContain("mode === 'current-session'")
        expect(source).toContain('artifact set')
        expect(source).toContain('previewConflicts')
    })

    it('exposes one-way credential registration but no renderer secret read command', async () => {
        const [adapter, nativeModule, lib] = await Promise.all([
            readFile(`${ROOT}/src/services/r2/native-r2-adapter.ts`, 'utf8'),
            readFile(`${ROOT}/src-tauri/src/r2_native.rs`, 'utf8'),
            readFile(`${ROOT}/src-tauri/src/lib.rs`, 'utf8'),
        ])
        const rendererAndCommands = `${adapter}\n${lib}`
        expect(rendererAndCommands).toContain('r2_store_credential')
        expect(rendererAndCommands).toContain('r2_credential_status')
        expect(rendererAndCommands).not.toMatch(/r2_(?:get|read|load)_credential/)
        expect(nativeModule).toContain('fn load_credential(')
        expect(nativeModule).not.toMatch(/println!|dbg!|log::(?:debug|info|warn|error)!/)
    })

    it('pins maintained desktop-only SDK and vault dependencies', async () => {
        const cargo = await readFile(`${ROOT}/src-tauri/Cargo.toml`, 'utf8')
        expect(cargo).toContain('dependencies.aws-sdk-s3]')
        expect(cargo).toContain('version = "=1.122.0"')
        expect(cargo).toContain('dependencies.keyring]')
        expect(cargo).toContain('version = "=4.1.4"')
        expect(cargo).toContain('default-features = false')
    })
})
