import { Check, CloudUpload, FileJson, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import type {
    SingleImageMetadataMode,
    SingleImageOutputSettings,
} from '@/domain/workflow/single-image-draft'
import {
    DEFAULT_RIGHTS_OWNER,
    MAX_RIGHTS_OWNER_LENGTH,
    isRightsEffectiveDate,
    isRightsOwner,
} from '@/domain/workflow/bluehair-rights-policy'
import { useDefaultR2Readiness } from '@/hooks/useDefaultR2Readiness'
import { cn } from '@/lib/utils'
import {
    currentLocalRightsDate,
    formatGuidedRightsDateInput,
} from './guided-rights-date'

const MODES: readonly SingleImageMetadataMode[] = [
    'embedded',
    'sidecar-only',
    'strip-and-sidecar',
]

export function GuidedMetadataStep({
    value,
    disabled,
    onChange,
}: {
    value: SingleImageOutputSettings
    disabled: boolean
    onChange(patch: Partial<SingleImageOutputSettings>): void
}) {
    const { t } = useTranslation()
    const selectable = value.metadataMode === 'strip-only'
        ? [...MODES, 'strip-only' as const]
        : MODES
    const descriptions: Record<SingleImageMetadataMode, string> = {
        embedded: t('guided.metadata.embeddedHelp', '편집 정보를 이미지 안에 유지합니다. 개인 보관과 다시 불러오기에 편리해요.'),
        'sidecar-only': t('guided.metadata.sidecarHelp', '이미지는 받은 상태로 두고 편집 정보를 로컬 .nai-blue.json에도 저장합니다.'),
        'strip-and-sidecar': t('guided.metadata.cleanHelp', '공유용 이미지는 정화하고, 원본 생성 정보는 private sidecar에 분리합니다.'),
        'strip-only': t('guided.metadata.stripOnlyHelp', '이미지 메타데이터를 제거하지만 복구용 sidecar를 남기지 않는 기존 설정입니다.'),
    }
    const labels: Record<SingleImageMetadataMode, string> = {
        embedded: t('guided.metadata.embedded', '이미지에 포함'),
        'sidecar-only': t('guided.metadata.sidecar', '이미지 유지 + sidecar'),
        'strip-and-sidecar': t('guided.metadata.clean', '공유용 정화 + sidecar · 권장'),
        'strip-only': t('guided.metadata.stripOnly', '정화만 · 비권장'),
    }

    return (
        <fieldset className="divide-y divide-border/70 border-y border-border/70" disabled={disabled}>
            <legend className="sr-only">{t('guided.metadata.title', '이미지 메타데이터')}</legend>
            {selectable.map(mode => {
                const checked = value.metadataMode === mode
                return (
                    <label
                        key={mode}
                        className={cn(
                            'guided-choice-row flex min-h-[76px] cursor-pointer items-start gap-4 px-2 py-4 transition-colors focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring',
                            checked && 'bg-primary/[0.055]',
                        )}
                    >
                        <input
                            type="radio"
                            name="guided-metadata-mode"
                            value={mode}
                            checked={checked}
                            onChange={() => onChange(mode === 'strip-and-sidecar'
                                ? { metadataMode: mode }
                                : {
                                    metadataMode: mode,
                                    autoR2UploadProfileId: null,
                                    deleteOriginalAfterRelease: false,
                                    rightsXmpEnabled: false,
                                })}
                            className="mt-1 h-4 w-4 shrink-0 accent-primary"
                        />
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 text-sm font-semibold">
                                {labels[mode]}
                                {checked && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
                            </span>
                            <span className="mt-1 block max-w-[62ch] text-xs leading-5 text-muted-foreground">
                                {descriptions[mode]}
                            </span>
                        </span>
                    </label>
                )
            })}
            {value.metadataMode === 'strip-and-sidecar' && (
                <div className="py-4">
                    <ol className="grid gap-2 text-xs leading-5 text-muted-foreground sm:grid-cols-3">
                        <li><span className="mr-1.5 font-mono text-primary">1</span>{t('guided.metadata.stepPreserve', '생성 정보를 sidecar로 준비')}</li>
                        <li><span className="mr-1.5 font-mono text-primary">2</span>{t('guided.metadata.stepClean', '청크·픽셀 은닉 정보 제거')}</li>
                        <li><span className="mr-1.5 font-mono text-primary">3</span>{t('guided.metadata.stepCommit', '이미지와 sidecar를 함께 검증')}</li>
                    </ol>
                </div>
            )}
        </fieldset>
    )
}

export function GuidedRightsStep({
    value,
    disabled,
    onChange,
}: {
    value: SingleImageOutputSettings
    disabled: boolean
    onChange(patch: Partial<SingleImageOutputSettings>): void
}) {
    const { t } = useTranslation()
    const dateId = useId()
    const owner = value.rightsOwner ?? DEFAULT_RIGHTS_OWNER
    const ownerInvalid = value.rightsXmpEnabled === true && !isRightsOwner(owner)
    const dateInvalid = value.rightsXmpEnabled === true
        && !isRightsEffectiveDate(value.rightsEffectiveDate)

    return (
        <div className="divide-y divide-border/70 border-y border-border/70">
            <label className="flex min-h-[76px] cursor-pointer items-start gap-3 px-2 py-5 sm:px-3">
                <Checkbox
                    className="mt-0.5"
                    checked={value.rightsXmpEnabled === true}
                    disabled={disabled}
                    onCheckedChange={checked => onChange({ rightsXmpEnabled: checked === true })}
                />
                <span>
                    <span className="flex items-center gap-2 text-sm font-semibold">
                        <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                        {t('guided.metadata.rightsEnable', '정화 이미지에 소유권 XMP 표시')}
                    </span>
                    <span className="mt-1 block max-w-[60ch] text-xs leading-5 text-muted-foreground">
                        {t('guided.metadata.rightsHelp', '입력한 이름을 소유자, 저작권, 사용 조건에 동일하게 넣습니다. 프롬프트는 계속 private sidecar에만 남습니다.')}
                    </span>
                </span>
            </label>

            {value.rightsXmpEnabled === true && (
                <section className="grid gap-4 py-5 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-start">
                    <label className="grid gap-1.5 text-xs font-medium">
                        <span>{t('guided.metadata.rightsOwner', 'XMP 소유자명')}</span>
                        <input
                            type="text"
                            value={owner}
                            maxLength={MAX_RIGHTS_OWNER_LENGTH}
                            disabled={disabled}
                            aria-invalid={ownerInvalid}
                            onChange={event => onChange({ rightsOwner: event.target.value })}
                            className="min-h-11 border-x-0 border-y border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                        />
                    </label>
                    <div className="grid gap-1.5 text-xs font-medium">
                        <span className="flex min-h-8 items-center justify-between gap-2">
                            <label htmlFor={dateId}>{t('guided.metadata.rightsDate', '권리 효력 시작일')}</label>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs"
                                disabled={disabled}
                                onClick={() => onChange({ rightsEffectiveDate: currentLocalRightsDate() })}
                            >
                                {t('guided.metadata.rightsDateToday', '오늘 날짜 사용')}
                            </Button>
                        </span>
                        <input
                            id={dateId}
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={10}
                            placeholder="YYYYMMDD"
                            value={value.rightsEffectiveDate ?? ''}
                            disabled={disabled}
                            aria-invalid={dateInvalid}
                            onChange={event => {
                                const formatted = formatGuidedRightsDateInput(event.target.value)
                                onChange({ rightsEffectiveDate: formatted || null })
                            }}
                            className="min-h-11 border-x-0 border-y border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-55"
                        />
                        <span className="font-normal text-muted-foreground">
                            {t('guided.metadata.rightsDateFormat', '숫자 8자리 · 예: 20260814')}
                        </span>
                    </div>
                    <p className={cn(
                        'text-xs leading-5 sm:col-span-2',
                        ownerInvalid || dateInvalid ? 'text-destructive' : 'text-muted-foreground',
                    )}>
                        {ownerInvalid
                            ? t('guided.metadata.rightsOwnerRequired', '소유자명을 앞뒤 공백 없이 한 줄로 입력해 주세요.')
                            : dateInvalid
                                ? t('guided.metadata.rightsDateRequired', '날짜를 직접 입력해야 설정 검토를 진행할 수 있어요.')
                                : t('guided.metadata.rightsFieldsHelp', '기본 소유자명은 bluehair.blue이며 직접 변경할 수 있습니다. 날짜는 자동으로 채우지 않습니다.')}
                    </p>
                </section>
            )}
        </div>
    )
}

export function GuidedDeliveryStep({
    value,
    disabled,
    onChange,
}: {
    value: SingleImageOutputSettings
    disabled: boolean
    onChange(patch: Partial<SingleImageOutputSettings>): void
}) {
    const { t } = useTranslation()
    const r2State = useDefaultR2Readiness()
    const autoUpload = value.autoR2UploadProfileId === DEFAULT_R2_PROFILE_ID
    const clearedUnavailableUploadRef = useRef(false)

    useEffect(() => {
        const shouldClear = !disabled && autoUpload && r2State.status === 'unavailable'
        if (shouldClear && !clearedUnavailableUploadRef.current) {
            clearedUnavailableUploadRef.current = true
            onChange({ autoR2UploadProfileId: null })
        } else if (!shouldClear) {
            clearedUnavailableUploadRef.current = false
        }
    }, [autoUpload, disabled, onChange, r2State.status])

    return (
        <div className="divide-y divide-border/70 border-y border-border/70">
            <section className={cn('py-5', r2State.status !== 'ready' && 'text-muted-foreground')}>
                <label className={"choice-row " + (cn(
                    'flex min-h-11 items-start gap-3 px-2 text-sm font-medium sm:px-3',
                    r2State.status !== 'ready' && 'cursor-not-allowed opacity-55',
                ))}>
                    <Checkbox
                        className="mt-0.5"
                        checked={autoUpload}
                        disabled={disabled || r2State.status !== 'ready'}
                        onCheckedChange={checked => onChange({
                            autoR2UploadProfileId: checked === true ? DEFAULT_R2_PROFILE_ID : null,
                        })}
                    />
                    <span>
                        <span className="flex items-center gap-2 font-semibold">
                            <CloudUpload className="h-4 w-4" aria-hidden="true" />
                            {t('guided.metadata.autoR2', '검증 후 R2에 자동 업로드')}
                        </span>
                        <span className="mt-1 block text-xs font-normal leading-5">
                            {r2State.status === 'ready'
                                ? t('guided.metadata.r2Ready', '{{bucket}} 프로필을 이번 작업에 사용합니다.', { bucket: value.r2Bucket ?? r2State.profile.bucket })
                                : r2State.status === 'loading'
                                    ? t('guided.metadata.r2Checking', '저장된 R2 프로필을 확인하고 있어요.')
                                    : t('guided.metadata.r2Unavailable', 'R2 설정과 API 키가 준비되어야 선택할 수 있어요.')}
                        </span>
                        {r2State.status === 'ready' && value.r2Prefix && (
                            <span className="mt-1 block font-mono text-xs font-normal text-muted-foreground">
                                {value.r2Bucket ?? r2State.profile.bucket}/{value.r2Prefix}
                            </span>
                        )}
                    </span>
                </label>
                {r2State.status === 'unavailable' && (
                    <Button asChild type="button" variant="outline" size="sm" className="mt-3 min-h-10 opacity-100">
                        <Link to="/guided-preview/task/library/r2">
                            <CloudUpload className="mr-2 h-4 w-4" aria-hidden="true" />
                            {t('guided.metadata.r2Cta', 'R2 업로드 설정하기')}
                        </Link>
                    </Button>
                )}
            </section>

            <label className="flex min-h-[76px] cursor-pointer items-start gap-3 px-2 py-5 text-sm font-medium sm:px-3">
                <Checkbox
                    className="mt-0.5"
                    checked={value.deleteOriginalAfterRelease === true}
                    disabled={disabled}
                    onCheckedChange={checked => onChange({ deleteOriginalAfterRelease: checked === true })}
                />
                <span>
                    <span className="font-semibold">
                        {t('guided.metadata.deleteOriginal', '검증 성공 후 정화 전 원본 폐기')}
                    </span>
                    <span className="mt-1 block max-w-[60ch] text-xs font-normal leading-5 text-muted-foreground">
                        {t('guided.metadata.deleteOriginalHelp', '기본값은 보관입니다. 정화·sidecar 저장과 선택한 업로드까지 성공한 뒤에만 원본을 폐기합니다.')}
                    </span>
                </span>
            </label>

            <p className="flex items-start gap-2 py-4 text-xs leading-5 text-muted-foreground">
                {autoUpload
                    ? <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    : <FileJson className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                {autoUpload && r2State.status === 'ready'
                    ? r2State.profile.publicMode === 'private'
                        ? t('guided.metadata.privateUpload', '비공개 프로필에는 정화 이미지와 private sidecar를 함께 업로드합니다.')
                        : t('guided.metadata.publicUpload', '공개 프로필에는 정화된 이미지만 업로드하고, 프롬프트 sidecar는 로컬에 남깁니다.')
                    : t('guided.metadata.localOnly', '자동 업로드를 선택하지 않으면 이미지와 sidecar는 로컬에만 저장합니다.')}
            </p>
        </div>
    )
}
