import { callAgentProxy } from '@shared/lib/edge-function-contracts';
import { logger } from '@shared/lib/logger';

export interface ExtractedProduct {
  name: string;
  price: number;
}

function getModel(): string {
  return (import.meta.env['VITE_AGENT_MODEL'] as string | undefined) ?? 'claude-sonnet-4-6';
}

const EXTRACTION_PROMPT =
  'Extract all menu items. Return ONLY valid JSON: [{"name":"...","price":0.0}]. No explanation.';

function parseProducts(responseText: string): ExtractedProduct[] {
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : responseText.trim();
    const parsed = JSON.parse(jsonStr) as unknown;
    if (!Array.isArray(parsed)) return [];
    const products: ExtractedProduct[] = [];
    for (const item of parsed) {
      if (
        item !== null &&
        typeof item === 'object' &&
        'name' in item &&
        'price' in item &&
        typeof (item as Record<string, unknown>)['name'] === 'string' &&
        typeof (item as Record<string, unknown>)['price'] === 'number'
      ) {
        products.push({
          name: (item as { name: string; price: number }).name,
          price: (item as { name: string; price: number }).price,
        });
      }
    }
    return products;
  } catch {
    return [];
  }
}

function findTextBlock(content: { type: string }[]): { type: 'text'; text: string } | undefined {
  return content.find((b): b is { type: 'text'; text: string } => b.type === 'text');
}

export async function extractProductsFromImage(
  imageBase64: string,
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
): Promise<ExtractedProduct[]> {
  const result = await callAgentProxy({
    model: getModel(),
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT,
          },
        ],
      },
    ],
  });
  if (!result.ok) {
    logger.warn('vision.extractProductsFromImage.failed', { detail: result.error.message });
    return [];
  }
  const textBlock = findTextBlock(result.data.content);
  if (!textBlock) return [];
  return parseProducts(textBlock.text);
}

export async function extractProductsFromText(text: string): Promise<ExtractedProduct[]> {
  const result = await callAgentProxy({
    model: getModel(),
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `${text}\n\n${EXTRACTION_PROMPT}`,
      },
    ],
  });
  if (!result.ok) {
    logger.warn('vision.extractProductsFromText.failed', { detail: result.error.message });
    return [];
  }
  const textBlock = findTextBlock(result.data.content);
  if (!textBlock) return [];
  return parseProducts(textBlock.text);
}
