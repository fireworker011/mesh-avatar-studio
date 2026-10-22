import type { PoseLandmark } from './pose-landmarks';
import { silhouetteLandmarks } from './pose-landmarks';

export type PoseDetector = 'auto' | 'photo' | 'line' | 'outline';

function isVideoFrame(source: CanvasImageSource): source is VideoFrame {
  return typeof VideoFrame !== 'undefined' && source instanceof VideoFrame;
}

function sourceSize(source: CanvasImageSource): { width: number; height: number } {
  if (source instanceof HTMLImageElement) return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  if (source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight };
  if (source instanceof SVGImageElement) {
    const box = source.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }
  if (isVideoFrame(source)) return { width: source.displayWidth, height: source.displayHeight };
  return { width: source.width, height: source.height };
}

function drawFlat(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return canvas;
  context.fillStyle = '#c8c8c8';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0);
  return canvas;
}

function contrastCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return source;
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  let low = 255, high = 0;
  for (let i = 0; i < pixels.length; i += 16) {
    const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    if (luma < low) low = luma;
    if (luma > high) high = luma;
  }
  const scale = 255 / Math.max(24, high - low);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = Math.max(0, Math.min(255, (pixels[i] - low) * scale));
    pixels[i + 1] = Math.max(0, Math.min(255, (pixels[i + 1] - low) * scale));
    pixels[i + 2] = Math.max(0, Math.min(255, (pixels[i + 2] - low) * scale));
  }
  const sharpened = new Uint8ClampedArray(pixels);
  const width = canvas.width;
  for (let y = 1; y < canvas.height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const center = pixels[index + channel];
        const blur = (pixels[index - 4 + channel] + pixels[index + 4 + channel] + pixels[index - width * 4 + channel] + pixels[index + width * 4 + channel]) / 4;
        sharpened[index + channel] = Math.max(0, Math.min(255, center + (center - blur) * 0.85));
      }
    }
  }
  image.data.set(sharpened);
  context.putImageData(image, 0, 0);
  return canvas;
}

/** Flat gray, and for line art a contrast pass. Photo mode skips the second pass. */
export function preparePoseCanvases(source: CanvasImageSource, mode: 'auto' | 'photo' | 'line'): HTMLCanvasElement[] {
  const { width, height } = sourceSize(source);
  if (width < 8 || height < 8) return [];
  const flat = drawFlat(source, width, height);
  if (mode === 'photo') return [flat];
  const line = contrastCanvas(flat);
  if (mode === 'line') return [line];
  return [flat, line];
}

function figureMask(image: ImageData): Uint8Array {
  const { data, width, height } = image;
  const mask = new Uint8Array(width * height);
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 240) clear++;
  const useAlpha = clear > width * height * 0.02;
  const red = data[0], green = data[1], blue = data[2];
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel++) {
    if (useAlpha) mask[pixel] = data[i + 3] > 16 ? 1 : 0;
    else {
      const delta = Math.abs(data[i] - red) + Math.abs(data[i + 1] - green) + Math.abs(data[i + 2] - blue);
      mask[pixel] = delta > 36 ? 1 : 0;
    }
  }
  return mask;
}

/** Second detector: the opaque (or non-background) silhouette, with no neural model. */
export function outlineFromSource(source: CanvasImageSource): PoseLandmark[] | null {
  const { width, height } = sourceSize(source);
  if (width < 8 || height < 8) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0);
  const mask = figureMask(context.getImageData(0, 0, width, height));
  return silhouetteLandmarks(width, height, (x, y) => mask[y * width + x] === 1);
}
