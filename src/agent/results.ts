/** Keep links tied to pages observed by the task; the text itself is the agent's reply. */
export function formatTaskResult(text: string, visitedUrls: string[] = []): string {
  const known = new Set(visitedUrls);
  return text.replace(/\[([^\]]+)\]\(<?(https?:\/\/[^)>]+)>?\)/g, (match, label: string, url: string) => known.has(url) ? match : label);
}
