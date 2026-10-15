import { AIError } from './client';

/** Generates a square image with fal's FLUX schnell model and returns the image bytes. */
export async function generateImage(falKey: string, prompt: string): Promise<Buffer> {
  const res = await fetch('https://fal.run/fal-ai/flux/schnell', {
    method: 'POST',
    headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_size: 'square_hd', num_images: 1, enable_safety_checker: true }),
    signal: AbortSignal.timeout(120_000),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw new AIError(`fal image generation failed (${res.status}): ${JSON.stringify(data?.detail ?? data).slice(0, 200)}`);
  const url = data?.images?.[0]?.url;
  if (!url) throw new AIError('fal returned no image.');
  if (String(url).startsWith('data:')) return Buffer.from(String(url).split(',')[1] ?? '', 'base64');
  const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!img.ok) throw new AIError(`Could not download the generated image (${img.status}).`);
  return Buffer.from(await img.arrayBuffer());
}
