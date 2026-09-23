import { beforeEach } from 'vitest'

import { setRuntimeCompositionDocument } from '@/lib/composition-authority'

beforeEach(() => {
    setRuntimeCompositionDocument(null)
})
