import { useEffect } from 'react'

import { runtimeCapabilities } from '@/platform/capabilities'
import { runR2ForegroundScheduler, useR2ForegroundState } from '@/services/r2/foreground-scheduler'
import { nativeR2CredentialStatus } from '@/services/r2/native-r2-adapter'
import { getRuntimeR2UploadCoordinator, getRuntimeR2UploadRepository } from '@/services/r2/runtime'

/** Foreground-only runtime; pending delivery uses its enqueue-time profile and credential binding. */
export function useR2UploadRuntime(): void {
    useEffect(() => {
        if (!runtimeCapabilities.r2ForegroundUpload.supported) return
        let cancelled = false
        useR2ForegroundState.setState({ status: 'running', blockedJobIds: [], faultedJobIds: [], diagnosticEventId: null })
        void runR2ForegroundScheduler({
            repository: getRuntimeR2UploadRepository(),
            coordinator: getRuntimeR2UploadCoordinator(),
            credentialStatus: nativeR2CredentialStatus,
            isCancelled: () => cancelled,
            wait: () => new Promise(resolve => window.setTimeout(resolve, 1_000)),
            onState: state => useR2ForegroundState.setState(state),
        })
        return () => {
            cancelled = true
            useR2ForegroundState.setState({ status: 'stopped' })
        }
    }, [])
}
