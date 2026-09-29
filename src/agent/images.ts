import { readBytes } from '../storage/workspace';
import { mediaType } from '../shared/workspace';
import { IMAGE } from '../shared/tuning';

const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
});
/** A workspace image as a data URL for a model request, scaled down when it is large. Runs in the task page. */
/** Larger images are scaled down and re-encoded. */
export async function imageDataUrl(taskId: string, path: string): Promise<string> {
  const type = mediaType(path);
  const blob = new Blob([await readBytes(taskId, path) as Uint8Array<ArrayBuffer>], { type });
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, IMAGE.maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && blob.size <= IMAGE.keepBytes && type !== 'image/gif') return dataUrl(blob);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const context = canvas.getContext('2d')!;
    // JPEG has no transparency; show transparent areas as white, as most viewers do.
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return dataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
  } finally { bitmap.close(); }
}
