import { parseCompositionDocument } from '@/domain/composition/schema'
import type { CompositionDocument } from '@/domain/composition/types'

let runtimeDocument: CompositionDocument | null = null

/** Installs the converted CompositionDocument shared by generation workflows. */
export function setRuntimeCompositionDocument(document: CompositionDocument | null): void {
    runtimeDocument = document === null ? null : parseCompositionDocument(document)
}

export function getRuntimeCompositionDocument(): CompositionDocument | null {
    return runtimeDocument === null ? null : parseCompositionDocument(runtimeDocument)
}
