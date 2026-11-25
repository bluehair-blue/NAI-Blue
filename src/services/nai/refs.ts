import { NAI_ENDPOINTS } from '@/services/nai/endpoints'
import { getNovelAiModelProfile } from '@/services/nai/model-catalog'
import { fitV5ReferenceBucket } from '@/services/nai/reference-bucket'
import type { CharacterReferenceOptions, I2iOptions, VibeOptions } from '@/services/nai/payload'
import type { GenerationParams } from '@/services/novelai-types'

const MAX_NAI_PIXELS = 1216 * 1216

export function stripBase64Header(base64: string): string {
    return base64.replace(/^data:[^,]+,/, '')
}

function toDataUrl(base64: string, mimeType = 'image/png'): string {
    return base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`
}

function loadImage(base64: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'))
        image.src = toDataUrl(base64)
    })
}

function canvasToPngBase64(canvas: HTMLCanvasElement): string {
    return stripBase64Header(canvas.toDataURL('image/png'))
}

export function snapNaiResolution(width: number, height: number): { width: number; height: number } {
    let nextWidth = width
    let nextHeight = height
    if (nextWidth * nextHeight > MAX_NAI_PIXELS) {
        const scale = Math.sqrt(MAX_NAI_PIXELS / (nextWidth * nextHeight))
        nextWidth *= scale
        nextHeight *= scale
    }
    const snap = (value: number) => Math.max(64, Math.round(value / 64) * 64)
    return { width: snap(nextWidth), height: snap(nextHeight) }
}

async function resizeFillPng(base64: string, width: number, height: number): Promise<string> {
    const image = await loadImage(base64)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas context failed')
    context.drawImage(image, 0, 0, width, height)
    image.src = ''
    return canvasToPngBase64(canvas)
}

export async function normalizeInpaintMask(maskBase64: string, width: number, height: number): Promise<string> {
    const image = await loadImage(maskBase64)
    const maskWidth = Math.max(1, Math.round(width / 8))
    const maskHeight = Math.max(1, Math.round(height / 8))
    const smallCanvas = document.createElement('canvas')
    smallCanvas.width = maskWidth
    smallCanvas.height = maskHeight
    const smallContext = smallCanvas.getContext('2d')
    if (!smallContext) throw new Error('Canvas context failed')
    smallContext.fillStyle = '#000'
    smallContext.fillRect(0, 0, maskWidth, maskHeight)
    smallContext.drawImage(image, 0, 0, maskWidth, maskHeight)
    image.src = ''

    const smallPixels = smallContext.getImageData(0, 0, maskWidth, maskHeight).data
    const outputCanvas = document.createElement('canvas')
    outputCanvas.width = width
    outputCanvas.height = height
    const outputContext = outputCanvas.getContext('2d')
    if (!outputContext) throw new Error('Canvas context failed')
    const output = outputContext.createImageData(width, height)

    for (let y = 0; y < height; y++) {
        const sourceY = Math.min(maskHeight - 1, Math.floor(y / 8))
        for (let x = 0; x < width; x++) {
            const sourceX = Math.min(maskWidth - 1, Math.floor(x / 8))
            const sourceOffset = (sourceY * maskWidth + sourceX) * 4
            const alpha = smallPixels[sourceOffset + 3]
            const brightness =
                (smallPixels[sourceOffset] + smallPixels[sourceOffset + 1] + smallPixels[sourceOffset + 2]) / 3
            const value = alpha > 25 && brightness > 25 ? 255 : 0
            const outputOffset = (y * width + x) * 4
            output.data[outputOffset] = value
            output.data[outputOffset + 1] = value
            output.data[outputOffset + 2] = value
            output.data[outputOffset + 3] = 255
        }
    }

    outputContext.putImageData(output, 0, 0)
    return canvasToPngBase64(outputCanvas)
}

export async function normalizeCharacterReferenceImage(imageBase64: string): Promise<string> {
    const image = await loadImage(imageBase64)
    const ratio = image.width / Math.max(1, image.height)
    const canvasSize =
        ratio > 1.2
            ? { width: 1536, height: 1024 }
            : ratio < 1 / 1.2
                ? { width: 1024, height: 1536 }
                : { width: 1472, height: 1472 }

    const scale = Math.min(canvasSize.width / image.width, canvasSize.height / image.height)
    const drawWidth = Math.round(image.width * scale)
    const drawHeight = Math.round(image.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = canvasSize.width
    canvas.height = canvasSize.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas context failed')
    context.fillStyle = '#000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(
        image,
        Math.round((canvas.width - drawWidth) / 2),
        Math.round((canvas.height - drawHeight) / 2),
        drawWidth,
        drawHeight,
    )
    image.src = ''
    return canvasToPngBase64(canvas)
}

/** V5 reference fit: cover-crop to the nearest aspect bucket, keeping real transparency. */
export async function fitCharacterReferenceToBucket(imageBase64: string): Promise<string> {
    const image = await loadImage(imageBase64)
    const source = document.createElement('canvas')
    source.width = image.width
    source.height = image.height
    const sourceContext = source.getContext('2d')
    if (!sourceContext) throw new Error('Canvas context failed')
    sourceContext.drawImage(image, 0, 0)
    image.src = ''
    // NovelAI results hide their metadata in the lowest alpha bit (254 in an opaque image, 1 in a transparent area).
    // It is cleared on the original pixels, before resampling can smear it into values this check would miss.
    const pixels = sourceContext.getImageData(0, 0, source.width, source.height)
    for (let offset = 3; offset < pixels.data.length; offset += 4) {
        if (pixels.data[offset] === 254) pixels.data[offset] = 255
        else if (pixels.data[offset] === 1) pixels.data[offset] = 0
    }
    sourceContext.putImageData(pixels, 0, 0)

    const fit = fitV5ReferenceBucket(source.width, source.height)
    const canvas = document.createElement('canvas')
    canvas.width = fit.width
    canvas.height = fit.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas context failed')
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, 0 - fit.left, 0 - fit.top, fit.resizeWidth, fit.resizeHeight)
    return canvasToPngBase64(canvas)
}

export interface NormalizedSource {
    width: number
    height: number
    imageBase64: string
    maskBase64?: string
    i2i: I2iOptions
}

export async function normalizeSourceForNai(params: GenerationParams): Promise<NormalizedSource | undefined> {
    if (!params.sourceImage) return undefined
    if (params.upscaledEnhance === true) {
        const imageBase64 = stripBase64Header(params.sourceImage)
        return {
            width: params.width,
            height: params.height,
            imageBase64,
            i2i: {
                strength: params.strength ?? 0.7,
                noise: params.noise ?? 0,
                extraNoiseSeed: Math.max(0, params.seed - 1),
                colorCorrect: false,
                imageBase64,
            },
        }
    }
    const snapped = snapNaiResolution(params.width, params.height)
    const imageBase64 = await resizeFillPng(params.sourceImage, snapped.width, snapped.height)
    const maskBase64 = params.mask
        ? await normalizeInpaintMask(params.mask, snapped.width, snapped.height)
        : undefined

    return {
        width: snapped.width,
        height: snapped.height,
        imageBase64,
        maskBase64,
        i2i: {
            strength: params.strength ?? 0.7,
            noise: params.noise ?? 0,
            extraNoiseSeed: Math.max(0, params.seed - 1),
            colorCorrect: false,
            imageBase64,
            maskBase64,
        },
    }
}

async function encodeVibeImage(
    token: string,
    imageBase64: string,
    informationExtracted: number,
    model: string,
): Promise<string> {
    const response = await fetch(NAI_ENDPOINTS.encodeVibe, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token.trim()}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            image: stripBase64Header(imageBase64),
            information_extracted: informationExtracted,
            model,
        }),
    })

    if (!response.ok) {
        // Provider bodies can echo request context; retain only the status for
        // the diagnostic registry and never put the body in Error.message.
        throw new Error(`Vibe encode failed (${response.status})`)
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }
    return btoa(binary)
}

export interface PreparedReferences {
    vibes?: VibeOptions[]
    characterReferences?: CharacterReferenceOptions[]
    newlyEncodedVibes: string[]
    source?: NormalizedSource
}

export async function prepareReferences(token: string, params: GenerationParams): Promise<PreparedReferences> {
    const newlyEncodedVibes: string[] = []
    const vibes: VibeOptions[] = []
    const vibeImages = params.vibeImages ?? []

    for (let index = 0; index < vibeImages.length; index++) {
        const preEncoded = params.preEncodedVibes?.[index]
        const encodedVibeBase64 = preEncoded
            ? stripBase64Header(preEncoded)
            : await encodeVibeImage(token, vibeImages[index], params.vibeInfo?.[index] ?? 1, params.model)
        if (!preEncoded) newlyEncodedVibes.push(encodedVibeBase64)
        vibes.push({
            encodedVibeBase64,
            strength: params.vibeStrength?.[index] ?? 0.6,
        })
    }

    const characterReferences: CharacterReferenceOptions[] = []
    const charImages = params.charImages ?? []
    const normalizeReference = getNovelAiModelProfile(params.model)?.capabilities.preciseReferenceRules?.imageFit === 'bucket'
        ? fitCharacterReferenceToBucket
        : normalizeCharacterReferenceImage
    for (let index = 0; index < charImages.length; index++) {
        const cacheSecretKey = params.charCacheKeys?.[index] ?? undefined
        characterReferences.push({
            referenceType: params.charReferenceType?.[index] ?? 'character&style',
            strength: params.charStrength?.[index] ?? 0.6,
            fidelity: params.charFidelity?.[index] ?? 0.6,
            cacheSecretKey,
            imageBase64: cacheSecretKey ? undefined : await normalizeReference(charImages[index]),
        })
    }

    return {
        vibes: vibes.length > 0 ? vibes : undefined,
        characterReferences: characterReferences.length > 0 ? characterReferences : undefined,
        newlyEncodedVibes,
        source: await normalizeSourceForNai(params),
    }
}
