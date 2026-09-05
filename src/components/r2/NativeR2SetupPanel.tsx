import { useEffect, useMemo, useState } from 'react'
import {
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    CircleHelp,
    ExternalLink,
    FolderOpen,
    Globe2,
    KeyRound,
    Loader2,
    LockKeyhole,
    PauseCircle,
    Play,
    Save,
    Settings2,
    ShieldCheck,
    UploadCloud,
    Wifi,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ExternalUrlLink } from '@/components/ui/external-url-link'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createR2ProfileV2, DEFAULT_R2_PROFILE_ID, hashR2ProfileV2, type R2ConflictPolicy, type R2ProfileHash, type R2ProfileV2, type R2PublicMode, type R2Transport } from '@/domain/r2/types'
import { runtimeCapabilities } from '@/platform/capabilities'
import {
    scanNativeR2Artifacts,
    filterNativeR2ArtifactsForProfile,
    nativeR2CredentialStatus,
    storeNativeR2Credential,
    testNativeR2Connection,
    testNativeR2TemporaryObject,
} from '@/services/r2/native-r2-adapter'
import { type R2UploadMode } from '@/services/r2/r2-upload-coordinator'
import { useR2ForegroundState } from '@/services/r2/foreground-scheduler'
import { getRuntimeR2UploadCoordinator, getRuntimeR2UploadRepository } from '@/services/r2/runtime'
import type { AssetProfile } from '@/types/asset-profile'

function Field({
    label,
    htmlFor,
    hint,
    children,
}: {
    label: string
    htmlFor?: string
    hint?: string
    children: React.ReactNode
}) {
    return (
        <div className="min-w-0 space-y-1.5">
            <Label htmlFor={htmlFor}>{label}</Label>
            {children}
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    )
}

/**
 * Each setup row binds one R2 decision to its matching beginner guidance. The
 * numbered label also preserves the ordered workflow for keyboard and screen-reader users.
 */
function SetupStep({
    label,
    description,
    guideTitle,
    guide,
    ready = false,
    children,
}: {
    label: string
    description: string
    guideTitle: string
    guide: React.ReactNode
    ready?: boolean
    children: React.ReactNode
}) {
    const separator = label.indexOf('. ')
    const number = separator >= 0 ? label.slice(0, separator) : label
    const title = separator >= 0 ? label.slice(separator + 2) : label

    // Each input/help column needs 32rem. Because rem follows the user's text
    // size, auto-fit keeps the desktop split but stacks at 200% text without
    // relying on a viewport breakpoint that cannot represent usable width.
    return (
        <li className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,32rem),1fr))] gap-5 border-t border-border py-6 first:border-t-0 first:pt-2 xl:gap-8">
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[2.75rem_minmax(0,1fr)] sm:gap-4">
                <div className="flex h-11 w-11 items-center justify-center border-b border-primary/55 font-mono text-sm font-semibold text-primary" aria-hidden="true">
                    {number}
                </div>
                <div className="min-w-0 space-y-4">
                    <div>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <h3 className="text-base font-semibold">{title}</h3>
                            {ready && (
                                <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                                    준비됨
                                </span>
                            )}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    </div>
                    {children}
                </div>
            </div>

            <aside className="min-w-0 border-l border-border/70 py-2 pl-4" aria-label={`${title} 입력 도움말`}>
                <div className="flex items-start gap-2">
                    <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <div className="min-w-0">
                        <h4 className="text-sm font-semibold">{guideTitle}</h4>
                        <div className="mt-2 space-y-2 text-sm leading-6 text-muted-foreground">{guide}</div>
                    </div>
                </div>
            </aside>
        </li>
    )
}

function initialProfile(profile: AssetProfile): R2ProfileV2 {
    return createR2ProfileV2({
        id: DEFAULT_R2_PROFILE_ID,
        name: 'Default R2',
        accountId: profile.r2.accountId ?? '',
        jurisdiction: null,
        endpoint: null,
        bucket: profile.r2.bucket ?? '',
        prefix: profile.r2.keyPrefix ?? '',
        credentialRef: 'r2-system-default',
        transport: 'native-s3',
        conflictPolicy: 'fail',
        publicMode: profile.r2.publicBaseUrl ? 'custom' : 'private',
        publicBaseUrl: profile.r2.publicBaseUrl ?? null,
    })
}

/** Keeps edits made during an async save while accepting the stored readback for an unchanged draft. */
export function reconcileR2ProfileSaveDraft(
    currentDraft: R2ProfileV2,
    submittedProfileHash: R2ProfileHash,
    storedProfile: R2ProfileV2,
): R2ProfileV2 {
    return hashR2ProfileV2(currentDraft) === submittedProfileHash ? storedProfile : currentDraft
}

export function NativeR2SetupPanel({
    assetProfile,
    localRoot,
    onLocalRootChange,
    onPersistAssetProfile,
}: {
    assetProfile: AssetProfile
    localRoot: string
    onLocalRootChange: (value: string) => void
    onPersistAssetProfile: (profile: AssetProfile) => void
}) {
    const [profile, setProfile] = useState(() => initialProfile(assetProfile))
    const [observedProfileHash, setObservedProfileHash] = useState<R2ProfileHash | null>(null)
    const [accessKeyId, setAccessKeyId] = useState('')
    const [secretAccessKey, setSecretAccessKey] = useState('')
    const [mode, setMode] = useState<R2UploadMode>('delta')
    const [busy, setBusy] = useState<string | null>(null)
    const [status, setStatus] = useState('설정을 저장한 뒤 연결을 확인하세요.')
    const [statusTone, setStatusTone] = useState<'neutral' | 'success' | 'error'>('neutral')
    const [planSummary, setPlanSummary] = useState<string | null>(null)
    const [credentialAvailable, setCredentialAvailable] = useState(false)
    const [connectionVerified, setConnectionVerified] = useState(false)
    const [writeVerified, setWriteVerified] = useState(false)
    const [overwriteUploadPending, setOverwriteUploadPending] = useState(false)
    const [setupPage, setSetupPage] = useState(0)

    const foreground = runtimeCapabilities.r2ForegroundUpload
    const scheduler = useR2ForegroundState()
    const nativeEnabled = foreground.supported && profile.transport === 'native-s3'

    useEffect(() => {
        void getRuntimeR2UploadRepository().getProfile(DEFAULT_R2_PROFILE_ID).then(saved => {
            if (saved) {
                setProfile(saved)
                setObservedProfileHash(hashR2ProfileV2(saved))
            }
        })
    }, [])

    // The native bridge only reveals whether the OS vault entry exists; secret
    // values remain one-way and are never returned to this renderer component.
    useEffect(() => {
        let active = true
        if (!foreground.supported) return () => { active = false }
        void nativeR2CredentialStatus(profile.credentialRef)
            .then(result => {
                if (active) setCredentialAvailable(result.available)
            })
            .catch(() => {
                if (active) setCredentialAvailable(false)
            })
        return () => { active = false }
    }, [foreground.supported, profile.credentialRef])

    const pathPreview = useMemo(() => {
        const prefix = profile.prefix.replace(/^\/+|\/+$/g, '')
        return [prefix, 'example.png'].filter(Boolean).join('/')
    }, [profile.prefix])

    const update = <K extends keyof R2ProfileV2>(key: K, value: R2ProfileV2[K]) => {
        setProfile(current => ({ ...current, [key]: value, updatedAt: new Date().toISOString() }))
        if (key === 'accountId' || key === 'jurisdiction' || key === 'endpoint' || key === 'bucket' || key === 'credentialRef') {
            setConnectionVerified(false)
            setWriteVerified(false)
        }
    }

    const setFeedback = (message: string, tone: 'neutral' | 'success' | 'error' = 'neutral') => {
        setStatus(message)
        setStatusTone(tone)
    }

    const save = async () => {
        setBusy('save')
        const submittedProfile = profile
        const submittedProfileHash = hashR2ProfileV2(submittedProfile)
        try {
            const stored = await getRuntimeR2UploadRepository().putProfile(submittedProfile, observedProfileHash)
            setProfile(current => reconcileR2ProfileSaveDraft(current, submittedProfileHash, stored))
            setObservedProfileHash(hashR2ProfileV2(stored))
            onPersistAssetProfile({
                ...assetProfile,
                r2: {
                    ...assetProfile.r2,
                    enabled: true,
                    accountId: submittedProfile.accountId || undefined,
                    bucket: submittedProfile.bucket || undefined,
                    keyPrefix: submittedProfile.prefix || undefined,
                    publicBaseUrl: submittedProfile.publicBaseUrl || undefined,
                },
            })
            setFeedback('설정을 저장했습니다. 다음 실행에서도 같은 R2 설정을 사용할 수 있습니다.', 'success')
        } catch (error) {
            setFeedback(`설정을 저장하지 못했습니다. ${error instanceof Error ? error.message : '잠시 후 다시 시도해 주세요.'}`, 'error')
        } finally {
            setBusy(null)
        }
    }

    const saveCredential = async () => {
        setBusy('credential')
        try {
            await storeNativeR2Credential({ credentialRef: profile.credentialRef, accessKeyId, secretAccessKey })
            setAccessKeyId('')
            setSecretAccessKey('')
            setCredentialAvailable(true)
            setConnectionVerified(false)
            setWriteVerified(false)
            setFeedback('API 키를 이 기기의 보안 저장소에 안전하게 저장했습니다.', 'success')
        } catch (error) {
            setFeedback(`API 키를 저장하지 못했습니다. ${error instanceof Error ? error.message : '입력값을 확인해 주세요.'}`, 'error')
        } finally {
            setBusy(null)
        }
    }

    const runConnectionTest = async () => {
        setBusy('connection')
        try {
            await testNativeR2Connection(profile)
            setConnectionVerified(true)
            setFeedback('연결에 성공했습니다. 계정과 버킷 정보를 정상적으로 확인했습니다.', 'success')
        } catch (error) {
            setConnectionVerified(false)
            setFeedback(`연결을 확인하지 못했습니다. ${error instanceof Error ? error.message : '계정, 버킷, API 키를 확인해 주세요.'}`, 'error')
        } finally {
            setBusy(null)
        }
    }

    const runTemporaryObjectTest = async () => {
        setBusy('temporary')
        try {
            const result = await testNativeR2TemporaryObject(profile)
            const passed = result.put && result.head && result.deleted
            setWriteVerified(passed)
            setFeedback(
                passed
                    ? '업로드 권한 확인에 성공했습니다. 테스트 파일도 정상적으로 삭제했습니다.'
                    : '테스트 파일 정리가 완료되지 않았습니다. R2 버킷을 확인해 주세요.',
                passed ? 'success' : 'error',
            )
        } catch (error) {
            setWriteVerified(false)
            setFeedback(`업로드 권한을 확인하지 못했습니다. ${error instanceof Error ? error.message : 'API 키 권한을 확인해 주세요.'}`, 'error')
        } finally {
            setBusy(null)
        }
    }

    const startUpload = async () => {
        setBusy('upload')
        try {
            if (mode === 'current-session') {
                throw new Error('current-session은 generation output의 명시적 artifact set이 필요합니다. Directory scan은 delta/full-sync/dry-run에서만 사용하세요.')
            }
            const coordinator = getRuntimeR2UploadCoordinator()
            const artifacts = filterNativeR2ArtifactsForProfile(
                profile,
                await scanNativeR2Artifacts(localRoot, profile.prefix),
            )
            const plan = await coordinator.plan(profile, artifacts, mode)
            setPlanSummary(`찾은 파일 ${plan.total}개 · 완료된 파일 ${plan.alreadyCompleted}개 · 이번 작업 ${plan.jobs.length}개`)
            if (mode !== 'dry-run') {
                await coordinator.enqueuePlan(plan)
                const summary = await coordinator.runUntilIdle(profile)
                setFeedback(
                    `업로드 완료 ${summary.succeeded}개 · 실패 ${summary.failed}개 · 대기 ${summary.queued}개`,
                    summary.failed > 0 ? 'error' : 'success',
                )
            } else {
                const preview = await coordinator.previewConflicts(profile, plan)
                setFeedback(`미리보기: 새 파일 ${preview.missing}개 · 같은 파일 ${preview.alreadySame}개 · 이름 충돌 ${preview.conflicts}개 · 교체 예정 ${preview.overwrites}개 · 새 이름 사용 가능 ${preview.suffixAvailable}개. 실제 파일은 변경하지 않았습니다.`, 'success')
            }
        } catch (error) {
            setFeedback(`업로드를 완료하지 못했습니다. ${error instanceof Error ? error.message : '설정을 확인한 뒤 다시 시도해 주세요.'}`, 'error')
        } finally {
            setBusy(null)
        }
    }

    const requiredReadyCount = [
        localRoot.trim(),
        profile.accountId.trim(),
        profile.bucket.trim(),
        credentialAvailable,
    ].filter(Boolean).length
    const connectionReady = nativeEnabled
        && credentialAvailable
        && Boolean(profile.accountId.trim() && profile.bucket.trim())
    const uploadReady = connectionReady
        && connectionVerified
        && writeVerified
        && Boolean(localRoot.trim())

    const requestUpload = () => {
        if (mode !== 'dry-run' && profile.conflictPolicy === 'overwrite') {
            setOverwriteUploadPending(true)
            return
        }
        void startUpload()
    }

    // This root depends on the global readable type scale and contains IDs, paths,
    // and product names. The inherited rule lets 200% text wrap intrinsic-width
    // tokens instead of widening mobile main; inputs keep their own internal scroll.
    return (
        <section
            className="min-w-0 overflow-x-hidden [overflow-wrap:anywhere]"
            aria-label="Native R2 guided setup"
            data-testid="native-r2-guided-setup"
        >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 pb-5">
                <div className="min-w-0">
                    <h2 className="text-base font-semibold">순서대로 설정하고 업로드하세요</h2>
                    <p className="mt-1 text-sm text-muted-foreground">한 화면에는 두 단계만 보여드려요. 값을 입력하고 막히면 같은 줄의 설명을 확인하세요.</p>
                </div>
                <div className="flex min-h-11 flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="font-medium">필수 준비 {requiredReadyCount}/4</span>
                    <span className="inline-flex items-center gap-1.5">
                    {nativeEnabled ? <ShieldCheck className="h-4 w-4 text-success" /> : <PauseCircle className="h-4 w-4" />}
                        {nativeEnabled ? '이 기기에서 업로드 가능' : '현재 환경에서 업로드 불가'}
                    </span>
                </div>
            </div>

            {!foreground.supported && (
                <div className="border-y border-warning/35 py-4 text-sm" role="status">
                    <div className="font-medium">현재 실행 환경에서는 직접 업로드할 수 없습니다.</div>
                    <div className="mt-1 text-muted-foreground">설치형 NAI Blue 데스크톱 앱에서 이 화면을 다시 열어 주세요. 브라우저에서는 설정을 확인할 수 있지만 파일 업로드는 실행되지 않습니다.</div>
                </div>
            )}

            {foreground.supported && (
                <div className="border-y border-border/70 py-3 text-sm text-muted-foreground" role="status" aria-label="R2 자동 전달 상태">
                    {scheduler.status === 'retrying'
                        ? '전달 작업 목록을 읽지 못해 자동 재개를 기다리고 있습니다. 앱이 열려 있는 동안 다시 확인합니다.'
                        : scheduler.status === 'stopped'
                            ? '자동 전달이 중지되어 있습니다. 앱을 다시 열면 저장된 작업에서 이어집니다.'
                            : '앱이 열려 있는 동안 저장된 전달 작업을 자동으로 이어갑니다.'}
                    {scheduler.blockedJobIds.length > 0 && <p className="mt-1">설정 또는 보안 키 준비를 기다리는 작업 {scheduler.blockedJobIds.length}개. 기존 작업에 연결된 설정이 준비되면 자동 재개합니다.</p>}
                    {scheduler.faultedJobIds.length > 0 && <p className="mt-1">오류로 재확인을 기다리는 작업 {scheduler.faultedJobIds.length}개. 다른 준비된 작업은 계속 진행합니다.</p>}
                </div>
            )}

            <div className="border-y border-border/70 py-4" aria-label="R2 설정 진행률">
                <div className="flex items-center justify-between gap-4 text-sm font-semibold">
                    <span className="text-primary">단계 {setupPage * 2 + 1}–{Math.min(setupPage * 2 + 2, 10)}</span>
                    <span className="font-mono text-muted-foreground">{setupPage + 1} / 5</span>
                </div>
                <div className="mt-3 h-px bg-border">
                    <div className="h-full bg-primary transition-[width]" style={{ width: `${((setupPage + 1) / 5) * 100}%` }} />
                </div>
            </div>

            <ol className="min-w-0">
                {setupPage === 0 && <>
                <SetupStep
                    label="1. 업로드할 폴더 선택"
                    description="내 컴퓨터에서 R2로 보낼 이미지가 들어 있는 폴더를 지정합니다."
                    guideTitle="어떤 값을 넣나요?"
                    ready={Boolean(localRoot.trim())}
                    guide={<>
                        <p>NAI Blue가 결과 이미지를 저장하는 폴더 이름 또는 전체 경로를 입력하세요.</p>
                        <p><span className="font-medium text-foreground">예:</span> <span className="font-mono">NAI_Blue_Output</span> 또는 <span className="break-all font-mono">D:\Images\NAI_Blue_Output</span></p>
                    </>}
                >
                    <Field label="이미지 폴더" htmlFor="r2-local-root" hint="폴더 안의 업로드 가능한 결과 파일을 자동으로 찾습니다.">
                        <div className="relative">
                            <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                            <Input id="r2-local-root" className="pl-10" value={localRoot} onChange={event => onLocalRootChange(event.target.value)} placeholder="NAI_Blue_Output" />
                        </div>
                    </Field>
                </SetupStep>

                <SetupStep
                    label="2. Cloudflare 계정 연결"
                    description="내 R2 저장소가 속한 Cloudflare 계정을 알려 주세요."
                    guideTitle="Account ID는 어디에 있나요?"
                    ready={Boolean(profile.accountId.trim())}
                    guide={<>
                        <p>Cloudflare 대시보드의 R2 화면에서 <span className="font-medium text-foreground">Account ID</span>를 찾아 그대로 복사하세요. 이메일이나 계정 이름이 아닙니다.</p>
                        <ExternalUrlLink className="focus-ring inline-flex max-w-full flex-wrap items-center gap-1 rounded-control break-words text-left font-medium text-primary hover:underline" href="https://dash.cloudflare.com/">Cloudflare 대시보드 열기 <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /></ExternalUrlLink>
                    </>}
                >
                    <Field label="Cloudflare Account ID" htmlFor="r2-account-id" hint="앞뒤 공백 없이 Account ID 전체를 붙여 넣으세요.">
                        <Input id="r2-account-id" value={profile.accountId} onChange={event => update('accountId', event.target.value)} placeholder="예: 023e105f4ecef8ad9ca31a8372d0c353" autoComplete="off" />
                    </Field>

                    <details className="border-y border-border/60 py-3">
                        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-medium">
                            <Settings2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                            고급 연결 설정 <span className="text-xs font-normal text-muted-foreground">(대부분 변경하지 않음)</span>
                        </summary>
                        <div className="grid gap-3 pt-3 sm:grid-cols-2">
                            <Field label="연결 방식">
                                <Select value={profile.transport} onValueChange={value => update('transport', value as R2Transport)}>
                                    <SelectTrigger aria-label="R2 연결 방식"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="native-s3">앱에서 직접 업로드 (권장)</SelectItem>
                                        <SelectItem value="wrangler">Wrangler 사용</SelectItem>
                                        <SelectItem value="relay" disabled>Relay (지원 예정)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field label="데이터 관할 지역 코드" htmlFor="r2-jurisdiction" hint="관할 지역을 별도로 지정한 계정만 입력합니다.">
                                <Input id="r2-jurisdiction" value={profile.jurisdiction ?? ''} placeholder="예: eu" onChange={event => update('jurisdiction', event.target.value || null)} />
                            </Field>
                            <div className="sm:col-span-2">
                                <Field label="직접 지정할 연결 주소" htmlFor="r2-endpoint" hint="프록시나 별도 S3 연결 주소가 있을 때만 입력합니다.">
                                    <Input id="r2-endpoint" value={profile.endpoint ?? ''} placeholder="비워 두면 Account ID로 자동 구성" onChange={event => update('endpoint', event.target.value || null)} />
                                </Field>
                            </div>
                        </div>
                    </details>
                </SetupStep>
                </>}

                {setupPage === 1 && <>
                <SetupStep
                    label="3. 기본 업로드 위치 확인"
                    description="여기서는 연결 확인에 사용할 기본값만 정합니다. 생성 폴더마다 다른 버킷과 프리픽스를 지정할 수 있습니다."
                    guideTitle="폴더별 설정이 우선합니다"
                    ready={Boolean(profile.bucket.trim())}
                    guide={<>
                        <p><span className="font-medium text-foreground">버킷 이름</span>에는 연결 확인에 사용할 버킷을 정확히 입력하세요.</p>
                        <p>이미지 생성 시 선택한 폴더의 버킷·프리픽스가 있으면 이 기본값보다 우선합니다. 비워 둔 항목만 이 값을 사용합니다.</p>
                    </>}
                >
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="기본 R2 버킷" htmlFor="r2-bucket">
                            <Input id="r2-bucket" value={profile.bucket} onChange={event => update('bucket', event.target.value)} placeholder="예: nai-blue-images" autoComplete="off" />
                        </Field>
                        <Field label="기본 프리픽스 (선택)" htmlFor="r2-prefix">
                            <Input id="r2-prefix" value={profile.prefix} onChange={event => update('prefix', event.target.value)} placeholder="예: generated/2026" />
                        </Field>
                    </div>
                    <div className="border-y border-border/55 py-2 text-xs text-muted-foreground">
                        저장 경로 예시 <span className="ml-1 break-words font-mono text-foreground">{pathPreview || 'example.png'}</span>
                    </div>
                </SetupStep>

                <SetupStep
                    label="4. R2 API 키 저장"
                    description="NAI Blue가 내 버킷에 파일을 올릴 수 있도록 발급받은 두 값을 입력합니다."
                    guideTitle="두 값은 어디서 발급하나요?"
                    ready={credentialAvailable}
                    guide={<>
                        <p>Cloudflare R2의 <span className="font-medium text-foreground">R2 API Tokens</span>에서 토큰을 만들고, 권한은 대상 버킷의 <span className="font-medium text-foreground">Object Read & Write</span>로 선택하세요.</p>
                        <p>발급 직후 표시되는 <span className="font-medium text-foreground">Access Key ID</span>와 <span className="font-medium text-foreground">Secret Access Key</span>를 각각 복사합니다. Secret 값은 다시 표시되지 않을 수 있습니다.</p>
                    </>}
                >
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Access Key ID" htmlFor="r2-access-key">
                            <Input id="r2-access-key" type="password" autoComplete="off" value={accessKeyId} onChange={event => setAccessKeyId(event.target.value)} placeholder="Access Key ID 붙여넣기" />
                        </Field>
                        <Field label="Secret Access Key" htmlFor="r2-secret-key">
                            <Input id="r2-secret-key" type="password" autoComplete="off" value={secretAccessKey} onChange={event => setSecretAccessKey(event.target.value)} placeholder="Secret Access Key 붙여넣기" />
                        </Field>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-3">
                        <Button className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-center" type="button" variant="outline" onClick={saveCredential} disabled={!nativeEnabled || !accessKeyId || !secretAccessKey || busy !== null}>
                            {busy === 'credential' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                            API 키를 이 기기에 저장
                        </Button>
                        <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <LockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true" />
                            {credentialAvailable ? '저장된 API 키가 있습니다.' : 'API 키는 운영체제 보안 저장소에만 보관됩니다.'}
                        </span>
                    </div>
                </SetupStep>
                </>}

                {setupPage === 2 && <>
                <SetupStep
                    label="5. 연결 확인"
                    description="입력한 계정, 버킷, API 키가 서로 맞는지 확인합니다."
                    guideTitle="파일은 업로드하지 않습니다"
                    ready={connectionVerified}
                    guide={<p>이 확인은 버킷을 찾고 접근할 수 있는지만 검사합니다. 실패하면 Account ID, 버킷 이름, API 키를 다시 확인하세요.</p>}
                >
                    <Button type="button" variant="outline" onClick={runConnectionTest} disabled={!connectionReady || busy !== null}>
                        {busy === 'connection' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wifi className="mr-2 h-4 w-4" />}
                        R2 연결 확인
                    </Button>
                </SetupStep>

                <SetupStep
                    label="6. 업로드 권한 확인"
                    description="작은 테스트 파일을 올렸다가 바로 지워서 실제 업로드 권한을 확인합니다."
                    guideTitle="내 파일에는 영향을 주지 않습니다"
                    ready={writeVerified}
                    guide={<p>NAI Blue가 임시 파일 하나를 생성해 업로드·조회·삭제합니다. 연결 확인이 성공한 뒤 실행하세요.</p>}
                >
                    <Button className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-center" type="button" variant="outline" onClick={runTemporaryObjectTest} disabled={!nativeEnabled || !connectionVerified || busy !== null}>
                        {busy === 'temporary' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                        테스트 파일 업로드 후 삭제
                    </Button>
                </SetupStep>
                </>}

                {setupPage === 3 && <>
                <SetupStep
                    label="7. 같은 이름의 파일 처리"
                    description="R2에 같은 경로의 파일이 이미 있을 때 어떻게 할지 선택합니다."
                    guideTitle="안전하게 시작하려면"
                    guide={<>
                        <p>처음에는 <span className="font-medium text-foreground">업로드 중단</span>이 가장 안전합니다. 기존 파일을 바꾸지 않고 충돌 사실만 알려 줍니다.</p>
                        <p>반복 업로드가 많다면 <span className="font-medium text-foreground">같은 파일은 건너뛰기</span>를 선택하세요.</p>
                    </>}
                >
                    <Field label="같은 이름의 파일이 있을 때">
                        <Select value={profile.conflictPolicy} onValueChange={value => update('conflictPolicy', value as R2ConflictPolicy)}>
                            <SelectTrigger aria-label="같은 이름의 파일 처리 방식"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="fail">업로드 중단 — 기존 파일 보호</SelectItem>
                                <SelectItem value="skip-same">내용이 같으면 건너뛰기</SelectItem>
                                <SelectItem value="overwrite">기존 파일을 새 파일로 교체</SelectItem>
                                <SelectItem value="suffix">새 이름을 만들어 둘 다 보관</SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>
                </SetupStep>

                <SetupStep
                    label="8. 공개 링크 설정"
                    description="업로드한 이미지를 웹 주소로 열 수 있게 할지 선택합니다."
                    guideTitle="업로드 권한과 공개 여부는 다릅니다"
                    guide={<>
                        <p>개인 보관용이면 <span className="font-medium text-foreground">비공개</span>를 선택하세요.</p>
                        <p>공개 주소를 입력해도 Cloudflare의 공개 액세스가 자동으로 켜지지는 않습니다. R2 대시보드에서 r2.dev 또는 사용자 도메인을 먼저 연결해야 합니다.</p>
                    </>}
                >
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="공개 방식">
                            <Select value={profile.publicMode} onValueChange={value => update('publicMode', value as R2PublicMode)}>
                                <SelectTrigger aria-label="R2 공개 방식"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="private">비공개 — 링크 만들지 않음</SelectItem>
                                    <SelectItem value="r2-dev">r2.dev 공개 주소</SelectItem>
                                    <SelectItem value="custom">내 도메인 사용</SelectItem>
                                </SelectContent>
                            </Select>
                        </Field>
                        {profile.publicMode !== 'private' && (
                            <Field label="공개 기본 주소" htmlFor="r2-public-url" hint="마지막 /는 생략해도 됩니다.">
                                <div className="relative">
                                    <Globe2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                                    <Input id="r2-public-url" className="pl-10" value={profile.publicBaseUrl ?? ''} onChange={event => update('publicBaseUrl', event.target.value || null)} placeholder="https://assets.example.com" inputMode="url" />
                                </div>
                            </Field>
                        )}
                    </div>
                </SetupStep>
                </>}

                {setupPage === 4 && <>
                <SetupStep
                    label="9. 설정 저장"
                    description="지금 입력한 R2 설정을 다음에도 사용할 수 있도록 저장합니다."
                    guideTitle="API 키는 따로 보관됩니다"
                    guide={<p>여기에는 계정 ID, 버킷, 폴더, 업로드 규칙만 저장됩니다. 4번의 Secret Access Key는 설정 파일에 포함되지 않습니다.</p>}
                >
                    <div className="min-w-0 space-y-3">
                        <Button className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-center" type="button" onClick={save} disabled={busy !== null}>
                            {busy === 'save' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                            이 설정 저장
                        </Button>
                        <div className="min-w-0 break-words text-xs text-muted-foreground" data-r2-readable-text data-testid="r2-save-summary">
                            저장 위치: {profile.bucket || '버킷 미입력'} / {profile.prefix || '최상위 폴더'}
                        </div>
                    </div>
                </SetupStep>

                <SetupStep
                    label="10. 이미지 업로드"
                    description="준비한 폴더를 확인하고 R2 업로드를 시작합니다. 중단되어도 다시 이어서 실행할 수 있습니다."
                    guideTitle="처음이라면 미리보기도 가능합니다"
                    guide={<>
                        <p><span className="font-medium text-foreground">변경된 파일만 업로드</span>가 일반적인 선택입니다.</p>
                        <p>실제 업로드 전에 결과만 보고 싶다면 <span className="font-medium text-foreground">업로드 전 미리보기</span>를 선택하세요.</p>
                    </>}
                >
                    <div className="min-w-0 space-y-3">
                        {/* At 200% text, rem-based breakpoints also scale. Keeping this
                            pair stacked until lg prevents the target path from becoming
                            a one-character-wide column beside the upload-mode selector. */}
                        <div className="grid min-w-0 gap-3 lg:grid-cols-2 lg:items-end">
                            <Field label="업로드 범위">
                                <Select value={mode} onValueChange={value => setMode(value as R2UploadMode)}>
                                    <SelectTrigger aria-label="R2 업로드 범위"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="delta">새 파일과 변경된 파일만</SelectItem>
                                        <SelectItem value="full-sync">폴더 전체 확인 후 업로드</SelectItem>
                                        <SelectItem value="dry-run">업로드 전 미리보기</SelectItem>
                                        <SelectItem value="current-session" disabled>현재 작업 결과만 (지원 예정)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </Field>
                            <div className="min-w-0 border-y border-border/55 py-2 text-xs text-muted-foreground" data-r2-readable-text data-testid="r2-upload-target-summary">
                                <div className="font-medium text-foreground">대상 폴더</div>
                                <div className="mt-1 break-words font-mono">{localRoot || '-'}</div>
                                {planSummary && <div className="mt-1">{planSummary}</div>}
                            </div>
                        </div>
                        <Button className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-center" type="button" onClick={requestUpload} disabled={!uploadReady || busy !== null}>
                            {busy === 'upload' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : mode === 'dry-run' ? <Play className="mr-2 h-4 w-4" /> : <UploadCloud className="mr-2 h-4 w-4" />}
                            {mode === 'dry-run' ? '업로드 내용 미리보기' : '업로드 시작 / 이어하기'}
                        </Button>
                    </div>
                </SetupStep>
                </>}
            </ol>

            <nav className="flex items-center justify-between gap-3 border-t border-border/70 py-4" aria-label="R2 설정 단계 이동">
                <Button className="h-auto min-h-11 min-w-0 flex-1 whitespace-normal px-2 py-2 text-center leading-snug" type="button" variant="ghost" onClick={() => setSetupPage(page => Math.max(0, page - 1))} disabled={setupPage === 0}>
                    <ChevronLeft className="mr-2 h-4 w-4" aria-hidden="true" />이전 두 단계
                </Button>
                <Button className="h-auto min-h-11 min-w-0 flex-1 whitespace-normal px-2 py-2 text-center leading-snug" type="button" onClick={() => setSetupPage(page => Math.min(4, page + 1))} disabled={setupPage === 4}>
                    다음 두 단계<ChevronRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Button>
            </nav>

            <div
                className={`mt-2 flex min-h-11 items-start gap-2 border-y px-1 py-3 text-sm ${statusTone === 'success' ? 'border-success/35 text-foreground' : statusTone === 'error' ? 'border-destructive/40 text-foreground' : 'border-border/60 text-muted-foreground'}`}
                role="status"
                aria-live="polite"
            >
                {statusTone === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" /> : statusTone === 'error' ? <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" /> : <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                <span className="min-w-0 break-words">{status}</span>
            </div>
            <ConfirmDialog
                open={overwriteUploadPending}
                onOpenChange={setOverwriteUploadPending}
                title="R2의 기존 파일을 교체할까요?"
                description="같은 경로의 원격 파일이 새 파일로 바뀝니다. 이 작업은 NAI Blue 휴지통으로 복구할 수 없습니다."
                confirmText="확인 후 업로드"
                cancelText="취소"
                variant="destructive"
                onConfirm={async () => {
                    setOverwriteUploadPending(false)
                    await startUpload()
                }}
            />
        </section>
    )
}
