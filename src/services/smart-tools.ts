// @ts-ignore
import { Client } from "@gradio/client";
import { augmentImage, generateImage, upscaleImage, type GenerationParams } from '@/services/novelai-api'
import { canUseEnhanceMaxForPixels } from '@/services/nai/enhance-max'
import { getNovelAiModelProfile } from '@/services/nai/model-catalog'
import { assertRemoteImageProcessingConsent } from '@/services/privacy/remote-image-processing'

const KALOSCOPE_SPACE = "DraconicDragon/Kaloscope-artist-style-classifier"
const KALOSCOPE_ENDPOINT = "/predict"
const KALOSCOPE_PAYLOAD_DEFAULTS = {
    model_selection: "Kaloscope v2.0 ONNX",
    top_k: 5,
    threshold: 0,
} as const

const BRIA_SPACE = "briaai/BRIA-RMBG-2.0"
const ANIME_RMBG_SPACE = "skytnt/anime-remove-background"
const NAI_UPSCALE_MAX_INPUT_PIXELS = 3_145_728
export {
    NAI_ENHANCE_MAX_EXPOSE_PIXELS,
    NAI_ENHANCE_MAX_PIXELS,
    calculateEnhanceMaxScale,
    canUseEnhanceMaxForPixels,
} from '@/services/nai/enhance-max'

export type EnhanceMaxSettings = Pick<GenerationParams,
    | 'prompt'
    | 'negative_prompt'
    | 'model'
    | 'steps'
    | 'cfg_scale'
    | 'cfg_rescale'
    | 'sampler'
    | 'scheduler'
    | 'smea'
    | 'smea_dyn'
    | 'variety'
    | 'strength'
    | 'noise'
    | 'qualityToggle'
    | 'ucPreset'
>

export interface TagResult {
    label: string
    score: number
}

/**
 * Singleton class to manage Smart Tools
 */
class SmartToolsService {
    private static instance: SmartToolsService

    private constructor() { }

    public static getInstance(): SmartToolsService {
        if (!SmartToolsService.instance) {
            SmartToolsService.instance = new SmartToolsService()
        }
        return SmartToolsService.instance
    }

    /**
     * Analyze Artist/Style using Kaloscope (Hugging Face Space API)
     */
    public async analyzeStyle(
        imageUrl: string,
        _progressCallback: ((progress: number) => void) | undefined,
        consentVersion: number,
    ): Promise<TagResult[]> {
        assertRemoteImageProcessingConsent(consentVersion)
        try {
            const response = await fetch(imageUrl);
            const blob = await response.blob();

            console.log("SmartTools: Connecting to Kaloscope API...");
            const client = await Client.connect(KALOSCOPE_SPACE);

            const result = await client.predict(KALOSCOPE_ENDPOINT, {
                image: blob,
                ...KALOSCOPE_PAYLOAD_DEFAULTS,
            });

            console.log("Kaloscope raw result:", result);

            const dataArray = result.data as any[];
            const rawData = dataArray?.[0];

            if (typeof rawData === 'string') {
                const artists = rawData.split(',').map(a => a.trim()).filter(a => a.length > 0);
                return artists.map((artist, index) => ({
                    label: `artist:${artist}`,
                    score: 1 - (index * 0.05)
                }));
            }

            if (typeof rawData === 'object' && rawData !== null) {
                const entries = Object.entries(rawData as Record<string, number>);
                return entries
                    .map(([label, score]) => ({ label: `artist:${label}`, score }))
                    .sort((a, b) => b.score - a.score);
            }

            console.warn("Kaloscope: Unexpected result format", rawData);
            return [];
        } catch (error) {
            const message = this.getErrorMessage(error);
            console.error("Kaloscope API Error:", error);
            throw new Error(`Kaloscope API 연결 실패: ${message}`);
        }
    }

    /**
     * Remove background from an image using Hugging Face Space
     * Uses BRIA-RMBG-2.0 API with fallback to anime-remove-background
     */
    public async removeBackground(
        imageUrl: string,
        _progressCallback: ((progress: number) => void) | undefined,
        consentVersion: number,
    ): Promise<string> {
        assertRemoteImageProcessingConsent(consentVersion)
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const failureReasons: string[] = [];

        // Step 1: Try BRIA-RMBG-2.0 (best quality)
        try {
            console.log("SmartTools: Trying briaai/BRIA-RMBG-2.0...");
            const client = await Client.connect(BRIA_SPACE);
            const result = await client.predict("/image", { image: blob });

            const outputData = this.selectBriaBackgroundOutput(result.data);
            if (!outputData) {
                throw new Error("BRIA-RMBG-2.0 returned no processed image");
            }
            return await this.processGradioOutput(outputData);
        } catch (error) {
            const message = this.getErrorMessage(error);
            failureReasons.push(`BRIA-RMBG-2.0: ${message}`);
            console.warn("BRIA-RMBG-2.0 failed:", message);
        }

        // Step 2: Fallback skytnt/anime-remove-background
        try {
            console.log("SmartTools: Trying skytnt/anime-remove-background...");
            const client = await Client.connect(ANIME_RMBG_SPACE);
            const result = await client.predict("/rmbg_fn", { img: blob });

            const outputData = this.selectAnimeBackgroundOutput(result.data);
            if (!outputData) {
                throw new Error("anime-remove-background returned no result image");
            }
            return await this.processGradioOutput(outputData);
        } catch (error) {
            const message = this.getErrorMessage(error);
            failureReasons.push(`anime-remove-background: ${message}`);
            console.warn("anime-remove-background failed:", message);
        }

        throw new Error(`모든 배경 제거 서비스 연결 실패: ${failureReasons.join(' / ')}`);
    }

    /**
     * Process Gradio output (URL, path, or data URL)
     */
    private async processGradioOutput(outputData: unknown): Promise<string> {
        if (typeof outputData === 'string') {
            if (outputData.startsWith('http')) {
                const imgResponse = await fetch(outputData);
                const imgBlob = await imgResponse.blob();
                return await this.blobToDataUrl(imgBlob);
            }
            if (outputData.startsWith('data:')) {
                return outputData;
            }
        } else if (typeof outputData === 'object' && outputData !== null) {
            const fileData = outputData as { url?: unknown; path?: unknown };
            const outputUrl = typeof fileData.url === 'string'
                ? fileData.url
                : typeof fileData.path === 'string'
                    ? fileData.path
                    : undefined;

            if (outputUrl) {
                return await this.processGradioOutput(outputUrl);
            }
        }
        throw new Error("Invalid output format");
    }

    private selectBriaBackgroundOutput(data: unknown): unknown {
        if (!Array.isArray(data)) {
            return undefined;
        }

        // BRIA returns [image slider tuple, output file]; the file is the actual transparent PNG.
        const fileOutput = data[1];
        if (fileOutput) {
            return fileOutput;
        }

        const imageSliderOutput = data[0];
        return Array.isArray(imageSliderOutput) ? imageSliderOutput[1] : undefined;
    }

    private selectAnimeBackgroundOutput(data: unknown): unknown {
        if (!Array.isArray(data)) {
            return undefined;
        }

        // skytnt returns [mask image, result image]; the second slot is the removed-background image.
        return data[1];
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    /**
     * Convert Blob to Data URL
     */
    private blobToDataUrl(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Run NAI Director Tools (augment-image API)
     * Supports: bg-removal, lineart, sketch, colorize, emotion, declutter
     */
    public async directorTool(
        imageInput: string,
        token: string,
        reqType: 'bg-removal' | 'lineart' | 'sketch' | 'colorize' | 'emotion' | 'declutter',
        options?: { defry?: number; prompt?: string; emotion?: string }
    ): Promise<string> {
        // Convert URL to base64 data URL if needed
        let imageBase64 = imageInput
        if (!imageInput.startsWith('data:')) {
            const response = await fetch(imageInput)
            const blob = await response.blob()
            imageBase64 = await this.blobToDataUrl(blob)
        }

        const img = new Image()
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve()
            img.onerror = reject
            img.src = imageBase64
        })
        const width = img.width
        const height = img.height
        img.src = ''

        // For emotion type, combine emotion and prompt as "emotion;;prompt"
        let prompt = options?.prompt
        if (reqType === 'emotion' && options?.emotion) {
            prompt = `${options.emotion};;${options.prompt || ''}`
        }

        const result = await augmentImage(
            token,
            imageBase64,
            width,
            height,
            reqType,
            options?.defry,
            prompt,
        )

        if (!result.success || !result.imageData) {
            throw new Error(result.error || 'Director tool failed')
        }

        return `data:image/png;base64,${result.imageData}`
    }

    /**
     * Upscale image using NovelAI's provider-sized V5 upscale API.
     */
    public async upscale(imageInput: string, token: string): Promise<string> {
        // Convert URL to base64 data URL if needed
        let imageBase64 = imageInput
        if (!imageInput.startsWith('data:')) {
            const response = await fetch(imageInput)
            const blob = await response.blob()
            imageBase64 = await this.blobToDataUrl(blob)
        }

        const img = new Image()
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve()
            img.onerror = reject
            img.src = imageBase64
        })

        const width = img.width
        const height = img.height
        img.src = ''

        if (width * height > NAI_UPSCALE_MAX_INPUT_PIXELS) {
            throw new Error('업스케일 입력 이미지는 3MP 이하만 지원합니다.')
        }
        if (!imageBase64.startsWith('data:image/png;base64,')) {
            throw new Error('업스케일 입력은 PNG 이미지만 지원합니다.')
        }

        const result = await upscaleImage(token, imageBase64, width, height)

        if (!result.success || !result.imageData) {
            throw new Error(result.error || 'Upscale failed')
        }

        return `data:image/png;base64,${result.imageData}`
    }

    public async enhanceMax(
        imageInput: string,
        token: string,
        settings: EnhanceMaxSettings,
    ): Promise<string> {
        const profile = getNovelAiModelProfile(settings.model)
        if (!profile?.capabilities.enhanceMax) {
            throw new Error('선택한 이미지 모델은 Enhance MAX를 지원하지 않습니다.')
        }

        let imageBase64 = imageInput
        if (!imageInput.startsWith('data:')) {
            const response = await fetch(imageInput)
            const blob = await response.blob()
            imageBase64 = await this.blobToDataUrl(blob)
        }

        const img = new Image()
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve()
            img.onerror = reject
            img.src = imageBase64
        })

        const width = img.width
        const height = img.height
        img.src = ''

        if (!canUseEnhanceMaxForPixels(width, height)) {
            throw new Error('Enhance MAX는 3MP 목표 해상도의 80% 미만 이미지에서만 사용할 수 있습니다.')
        }

        const params: GenerationParams = {
            ...settings,
            model: profile.modelId,
            width,
            height,
            seed: Math.floor(Math.random() * 4_294_967_295),
            sourceImage: imageBase64,
            upscaledEnhance: true,
            imageFormat: 'png',
            metadataMode: 'strip-only',
        }
        const result = await generateImage(token, params)

        if (!result.success || !result.imageData) {
            throw new Error(result.error || 'Enhance MAX failed')
        }

        return `data:image/png;base64,${result.imageData}`
    }
}

export const smartTools = SmartToolsService.getInstance()
