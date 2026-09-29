/** An image of a random two-digit number, to check that the model reads images rather than guessing. */
export function visionProbe(): { dataUrl: string; answer: string } {
  const answer = String(10 + Math.floor(Math.random() * 90));
  const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 120;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000'; context.font = 'bold 80px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText(answer, canvas.width / 2, canvas.height / 2);
  return { dataUrl: canvas.toDataURL('image/png'), answer };
}
