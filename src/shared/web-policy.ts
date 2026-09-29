import { z } from 'zod';
import { LocalizedError } from '../i18n';

export const PAGE_SCHEMES = ['http', 'https', 'file'] as const;
export interface WebPolicy {
  allowedSchemes: (typeof PAGE_SCHEMES)[number][];
  allowLocalAddresses: boolean;
  allowPrivateAddresses: boolean;
  allowEmbeddedCredentials: boolean;
  blockedQueryParameters: string[];
  blockedFileExtensions: string[];
  blockDownloadPaths: boolean;
}
export const DEFAULT_WEB_POLICY: WebPolicy = {
  allowedSchemes: ['http', 'https'], allowLocalAddresses: true, allowPrivateAddresses: true,
  allowEmbeddedCredentials: false,
  blockedQueryParameters: ['token', 'access_token', 'api_key', 'apikey', 'authorization', 'password', 'secret', 'passkey', 'authkey', 'session', 'sessionid', 'csrf', 'csrftoken'],
  blockedFileExtensions: ['pdf', 'zip', 'exe', 'dmg', 'msi', 'torrent'],
  blockDownloadPaths: true,
};
/** Parameter names compare case-insensitively, ignoring a trailing [] and treating - as _. */
const parameterKey = (key: string) => key.trim().toLowerCase().replace(/\[\]$/, '').replace(/-/g, '_');
const list = z.array(z.string().trim().min(1).max(80)).max(100);
const schema = z.object({
  allowedSchemes: z.array(z.enum(PAGE_SCHEMES)).max(3), allowLocalAddresses: z.boolean(), allowPrivateAddresses: z.boolean(),
  allowEmbeddedCredentials: z.boolean(), blockedQueryParameters: list, blockedFileExtensions: list,
  blockDownloadPaths: z.boolean(),
}).partial();
export function normalizeWebPolicy(value?: unknown): WebPolicy {
  const parsed = schema.safeParse(value ?? {});
  const merged = { ...DEFAULT_WEB_POLICY, ...(parsed.success ? parsed.data : {}) };
  return { ...merged, allowedSchemes: [...new Set(merged.allowedSchemes)],
    blockedQueryParameters: [...new Set(merged.blockedQueryParameters.map(parameterKey))],
    blockedFileExtensions: [...new Set(merged.blockedFileExtensions.map(s => s.replace(/^\.+/, '').toLowerCase()).filter(Boolean))] };
}
export function validateWebPolicy(value: unknown): WebPolicy {
  if (!schema.safeParse(value).success) throw new LocalizedError('policy.invalidFormat');
  return normalizeWebPolicy(value);
}

type AddressKind = 'local' | 'private' | 'public';
function ipv4Kind(bytes: number[]): AddressKind {
  const [a, b] = bytes;
  if (a === 0 || a === 127) return 'local';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) return 'private';
  return 'public';
}
export function addressKind(hostname: string): AddressKind {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.localdomain')) return 'local';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return ipv4Kind(host.split('.').map(Number));
  if (host.includes(':')) {
    const [left, right] = host.split('::');
    const head = left ? left.split(':').map(n => parseInt(n, 16)) : [];
    const tail = right ? right.split(':').map(n => parseInt(n, 16)) : [];
    const words = right === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail];
    if (words.length === 8 && words.slice(0, 7).every(n => n === 0) && words[7] <= 1) return 'local';
    if (words.length === 8 && words.slice(0, 5).every(n => n === 0) && words[5] === 0xffff) return ipv4Kind([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
    // NAT64 (64:ff9b::/96) reaches the embedded IPv4 address.
    if (words.length === 8 && words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(n => n === 0)) return ipv4Kind([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
    if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80) return 'private';
    return 'public';
  }
  if (!host.includes('.') || ['.local', '.lan', '.internal', '.home', '.home.arpa'].some(suffix => host.endsWith(suffix))) return 'private';
  return 'public';
}

export function validatePageUrl(value: string, policy: WebPolicy = DEFAULT_WEB_POLICY): string {
  let url: URL; try { url = new URL(value); } catch { throw new LocalizedError('policy.invalidUrl'); }
  const scheme = url.protocol.slice(0, -1);
  if (!(PAGE_SCHEMES as readonly string[]).includes(scheme)) throw new LocalizedError('policy.unsupportedScheme');
  if (!(policy.allowedSchemes as readonly string[]).includes(scheme)) throw new LocalizedError('policy.schemeNotAllowed', { scheme });
  if ((url.username || url.password) && !policy.allowEmbeddedCredentials) throw new LocalizedError('policy.credentialsNotAllowed');
  const kind = addressKind(url.hostname);
  if (kind === 'local' && !policy.allowLocalAddresses) throw new LocalizedError('policy.localNotAllowed');
  if (kind === 'private' && !policy.allowPrivateAddresses) throw new LocalizedError('policy.privateNotAllowed');
  let pathname = url.pathname; try { pathname = decodeURIComponent(pathname); } catch { /* Match the original path if it cannot be decoded. */ }
  if (policy.blockedFileExtensions.some(ext => pathname.toLowerCase().endsWith('.' + ext))) throw new LocalizedError('policy.extensionBlocked');
  if (policy.blockDownloadPaths && /(?:^|\/)download(?:\.[a-z]+)?(?:\/|$)/i.test(pathname)) throw new LocalizedError('policy.downloadBlocked');
  const blocked = new Set(policy.blockedQueryParameters.map(parameterKey));
  // Fragments carry parameters too (#access_token=..., #/route?token=...).
  const fragment = url.hash.slice(1); const fragmentQuery = fragment.slice(fragment.indexOf('?') + 1);
  const keys = [...url.searchParams.keys(), ...(fragmentQuery.includes('=') ? new URLSearchParams(fragmentQuery).keys() : [])];
  if (keys.some(key => blocked.has(parameterKey(key)))) throw new LocalizedError('policy.parameterBlocked');
  return url.href;
}
export function pagePermissionPattern(value: string): string {
  const url = new URL(value);
  if (url.protocol === 'file:') return 'file:///*';
  if (!['http:', 'https:'].includes(url.protocol)) throw new LocalizedError('policy.permissionScheme');
  return `${url.protocol}//${url.hostname}/*`;
}
export function policyPermissionPatterns(policy: WebPolicy): string[] {
  return policy.allowedSchemes.map(scheme => scheme === 'file' ? 'file:///*' : `${scheme}://*/*`);
}
