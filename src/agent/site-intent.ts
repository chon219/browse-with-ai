import { DEFAULT_WEB_POLICY, validatePageUrl, type WebPolicy } from '../shared/web-policy';

/** Hints for the model, not routing rules. Only inspect user-authored requests; names without a URL are interpreted by the model. */
export function siteTargets(goal: string, policy: WebPolicy = DEFAULT_WEB_POLICY): string[] {
  if (/\bsite\s*:/i.test(goal)) return []; // An explicitly requested search-engine query.
  const explicit = /(?:https?|file):\/\/[^\s<>"'，。；！？（）\u4e00-\u9fff]+/gi;
  const matches = [...(goal.match(explicit) ?? []), ...(goal.replace(explicit, ' ').match(/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:\/[^\s<>"'，。；！？（）\u4e00-\u9fff]*)?/gi) ?? [])];
  const urls: string[] = [];
  for (const match of matches) {
    try {
      const value = match.replace(/[),.;\]]+$/, '');
      const url = validatePageUrl(/^(?:https?|file):\/\//i.test(value) ? value : `https://${value}`, policy);
      if (!urls.includes(url)) urls.push(url);
    } catch { /* Not a navigable website. */ }
  }
  return urls.slice(0, 5);
}
