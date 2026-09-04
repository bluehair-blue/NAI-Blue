import { IndexedDBR2UploadRepository } from './indexeddb-r2-upload-repository'
import { R2UploadCoordinator } from './r2-upload-coordinator'
import { getRuntimeArtifactRepository } from '@/services/organizer/runtime'

let repository: IndexedDBR2UploadRepository | null = null
let coordinator: R2UploadCoordinator | null = null

export function getRuntimeR2UploadRepository(): IndexedDBR2UploadRepository {
    repository ??= new IndexedDBR2UploadRepository({
        artifactReader: { get: artifactId => getRuntimeArtifactRepository().get(artifactId) },
    })
    return repository
}

export function getRuntimeR2UploadCoordinator(): R2UploadCoordinator {
    coordinator ??= new R2UploadCoordinator(getRuntimeR2UploadRepository())
    return coordinator
}
