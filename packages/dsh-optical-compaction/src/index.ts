import type { Context } from '@deepseek-ai/cordis'
import { Config, resolvePluginConfig, type PluginConfig } from './config.js'
import { OpticalCompactionEngine } from './engine.js'

export { Config, DEFAULT_SUMMARY_PROMPT, resolvePluginConfig } from './config.js'
export type { PluginConfig, ResolvedOpticalConfig, ResolvedPluginConfig } from './config.js'
export { OpticalCompactionEngine, toSnapcompactMessages } from './engine.js'
export { prepareOriginalImages, readOriginalImagePreviews, ORIGINAL_IMAGE_PREVIEWS_PREFIX, ORIGINAL_IMAGE_PREVIEW_MAX_EDGE } from './original-images.js'
export type { OriginalImagePreview, PreparedOriginalImages } from './original-images.js'
export * from './snapcompact.js'

export const name = 'dsh-optical-compaction'
export const inject = ['llm', 'attachments', 'tokenMeter', 'sessions', 'sessionPersistence']

/** Cordis plugin entry. Mount inside an isolated compaction realm. */
export function apply(ctx: Context, config: PluginConfig): void {
  if (ctx.get('compaction') !== undefined) {
    ctx.logger.warn('dsh-optical-compaction: ctx.compaction is already provided; optical backend was not installed')
    return
  }
  new OpticalCompactionEngine(ctx, resolvePluginConfig(config))
}

export default { name, inject, Config, apply }
