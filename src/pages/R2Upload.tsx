import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { NativeR2SetupPanel } from '@/components/r2/NativeR2SetupPanel'
import { toast } from '@/components/ui/use-toast'
import { useAssetModuleStore } from '@/stores/asset-module-store'
import type { AssetProfile } from '@/types/asset-profile'

export default function R2Upload() {
    const { t } = useTranslation()
    const profile = useAssetModuleStore(state => state.profile)
    const replaceProfileDraft = useAssetModuleStore(state => state.replaceProfileDraft)
    const saveToDisk = useAssetModuleStore(state => state.saveToDisk)
    const [localRoot, setLocalRoot] = useState(profile.output.directory ?? 'NAI_Blue_Output')

    // R2 still projects its non-secret settings into the shared generation profile;
    // credentials remain in the OS vault and never enter the persisted profile.
    const persistAssetProfile = useCallback((nextProfile: AssetProfile) => {
        replaceProfileDraft(nextProfile)
        void saveToDisk(nextProfile).catch(error => {
            toast({
                title: t('toast.saveFailed', '저장 실패'),
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            })
        })
    }, [replaceProfileDraft, saveToDisk, t])

    return (
        <div className="workspace-page space-y-8">
            <header className="workspace-heading">
                <h1>{t('nav.r2Upload', 'R2 Upload')}</h1>
                <p>{t('workspace.r2Hint', '저장소를 연결하고, 올릴 이미지와 공개 범위를 확인하세요.')}</p>
            </header>

            {/* This section is the horizontal scroll boundary for long credential/path inputs. */}
            <section className="min-w-0 overflow-x-hidden border-y border-border/70 px-1 py-4 sm:px-3 sm:py-5 lg:px-5 lg:py-6">
                <NativeR2SetupPanel
                    assetProfile={profile}
                    localRoot={localRoot}
                    onLocalRootChange={setLocalRoot}
                    onPersistAssetProfile={persistAssetProfile}
                />
            </section>
        </div>
    )
}
