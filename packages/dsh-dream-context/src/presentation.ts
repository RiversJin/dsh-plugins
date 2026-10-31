import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, offloadedImageText, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate';
import { estimateImageContextTokens } from '@riversjin/dsh-optical-compaction';
import { SOURCE } from './types.js';

/** Price both candidates under the current adapter's request-image projection.
 * Include the text handles as well as visual tokens. Images common to the two
 * representations are included on both sides, not treated as free. */
export function presentationTokens(ctx: Context, content: ContentBlock[], route: { provider?: string; model?: string }): number {
  const images = content.filter(block => block.type === 'image');
  const text: ContentBlock[] = content.flatMap(block => {
    if (block.type === 'image') return [];
    if (block.type === 'file') return [{ type: 'text' as const, text: ctx.llm.fileRequestText(block.attachment) }];
    return [block];
  });
  let tokens = ctx.tokenMeter.estimateMessage(createUserMessage({ content: text, source: { kind: SOURCE, form: 'episode' } }));
  const pricing = route.provider && route.model ? ctx.llm.imageRequestPricing(route.provider, route.model) : undefined;
  if (pricing) {
    const prices = pricing.priceImages(images);
    if (prices.length !== images.length) throw new Error('History image pricing returned a different occurrence count');
    for (const price of prices) tokens += price.visualTokens + estimateContent([{ type: 'text', text: price.text }]);
  } else {
    // Same conservative ceiling used by the old optical engine when the
    // adapter does not expose model-specific image pricing.
    for (const block of images) tokens += block.offloaded === true
      ? estimateContent([{ type: 'text', text: offloadedImageText(block.attachment) }])
      : estimateImageContextTokens(undefined, block.attachment.width, block.attachment.height);
  }
  return tokens;
}
