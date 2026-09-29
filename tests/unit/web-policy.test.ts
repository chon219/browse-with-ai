import { describe, expect, it, vi } from 'vitest';
import { addressKind, normalizeWebPolicy, pagePermissionPattern, policyPermissionPatterns, validatePageUrl, validateWebPolicy } from '../../src/shared/web-policy';
import { loadConfig, loadWebPolicy } from '../../src/storage/settings';
import { siteTargets } from '../../src/agent/site-intent';

describe('configurable webpage policy', () => {
  it.each(['http://localhost:3000/', 'http://127.0.0.1:8080/', 'http://127.1/', 'http://0x7f000001/', 'http://0.0.0.0:5173/', 'http://10.0.0.2/', 'http://172.31.0.1/', 'http://192.168.1.2/', 'http://169.254.1.1/', 'http://100.64.1.2/', 'http://intranet/', 'http://printer.local/', 'http://[::1]:8000/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:192.168.1.2]/', 'https://[2606:4700:4700::1111]/'])('allows local and private URLs by default: %s', url => {
    expect(validatePageUrl(url)).toBe(new URL(url).href);
  });
  it.each(['http://localhost/', 'http://app.localhost/', 'http://localhost./', 'http://2130706433/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/'])('can block local addresses: %s', url => {
    expect(() => validatePageUrl(url, normalizeWebPolicy({ allowLocalAddresses: false }))).toThrow('本机');
  });
  it.each(['http://10.0.0.1/', 'http://172.16.1.1/', 'http://192.168.0.1/', 'http://169.254.2.1/', 'http://100.100.1.1/', 'http://intranet/', 'http://nas.local/', 'http://[fc00::1]/', 'http://[febf::1]/', 'http://[::ffff:192.168.0.1]/'])('can block private addresses: %s', url => {
    expect(() => validatePageUrl(url, normalizeWebPolicy({ allowPrivateAddresses: false }))).toThrow('私网');
  });
  it('keeps local and private switches independent and allows public IPv6', () => {
    expect(validatePageUrl('http://localhost/', normalizeWebPolicy({ allowPrivateAddresses: false }))).toBe('http://localhost/');
    expect(validatePageUrl('http://10.0.0.1/', normalizeWebPolicy({ allowLocalAddresses: false }))).toBe('http://10.0.0.1/');
    expect(addressKind('[2606:4700:4700::1111]')).toBe('public');
    expect(addressKind('172.32.0.1')).toBe('public');
  });
  it('enforces enabled schemes and supports explicitly enabled local files', () => {
    expect(() => validatePageUrl('http://example.com/', normalizeWebPolicy({ allowedSchemes: ['https'] }))).toThrow('http');
    expect(() => validatePageUrl('https://example.com/', normalizeWebPolicy({ allowedSchemes: [] }))).toThrow('https');
    const filePolicy = normalizeWebPolicy({ allowedSchemes: ['file'] });
    expect(validatePageUrl('file:///C:/demo/page.html', filePolicy)).toBe('file:///C:/demo/page.html');
    expect(() => validatePageUrl('file:///C:/demo/page.html', { ...filePolicy, allowLocalAddresses: false })).toThrow('本机');
    expect(() => validateWebPolicy({ allowedSchemes: ['javascript'] })).toThrow('格式');
  });
  it('configures credentials, parameters, extensions and download paths independently', () => {
    const policy = normalizeWebPolicy({ allowEmbeddedCredentials: true, blockedQueryParameters: [], blockedFileExtensions: [], blockDownloadPaths: false });
    expect(validatePageUrl('https://user:pass@example.com/download.php?token=x', policy)).toContain('user:pass');
    expect(validatePageUrl('https://example.com/file.pdf', policy)).toContain('file.pdf');
    const custom = normalizeWebPolicy({ blockedFileExtensions: ['.PDF', 'tar.gz'], blockedQueryParameters: ['CustomKey'] });
    expect(() => validatePageUrl('https://example.com/a%2Epdf', custom)).toThrow('后缀');
    expect(() => validatePageUrl('https://example.com/a.tar.gz', custom)).toThrow('后缀');
    expect(() => validatePageUrl('https://example.com/?customkey=x', custom)).toThrow('参数');
    expect(validatePageUrl('https://example.com/?token=x', custom)).toContain('token');
  });
  it.each(['https://example.com/#access_token=x', 'https://example.com/#/cb?token=x', 'https://example.com/?API-Key=x', 'https://example.com/?token[]=x', 'https://example.com/?Access%2DToken=x'])('blocks credential parameters in any spelling or in the fragment: %s', url => {
    expect(() => validatePageUrl(url)).toThrow('参数');
  });
  it('normalizes configured parameter names and keeps ordinary fragments', () => {
    const custom = normalizeWebPolicy({ blockedQueryParameters: ['Custom-Key[]'] });
    expect(custom.blockedQueryParameters).toEqual(['custom_key']);
    expect(() => validatePageUrl('https://example.com/?custom_key=x', custom)).toThrow('参数');
    expect(validatePageUrl('https://example.com/#section-2')).toBe('https://example.com/#section-2');
    expect(validatePageUrl('https://example.com/#/tokens?page=2')).toContain('#/tokens');
  });
  it('treats .localdomain as local and NAT64 by its embedded IPv4 address', () => {
    expect(addressKind('host.localdomain')).toBe('local');
    expect(addressKind('[64:ff9b::7f00:1]')).toBe('local');
    expect(addressKind('[64:ff9b::c0a8:101]')).toBe('private');
    expect(addressKind('[64:ff9b::808:808]')).toBe('public');
  });
  it('generates permission patterns for local ports, IPv6 and file URLs', () => {
    expect(pagePermissionPattern('http://localhost:5173/page')).toBe('http://localhost/*');
    expect(pagePermissionPattern('http://[::1]:5173/page')).toBe('http://[::1]/*');
    expect(pagePermissionPattern('file:///C:/a.html')).toBe('file:///*');
    expect(policyPermissionPatterns(normalizeWebPolicy({ allowedSchemes: ['https', 'file'] }))).toEqual(['https://*/*', 'file:///*']);
  });
  it('loads policy without reading the API key and merges omitted settings', async () => {
    const get = vi.fn().mockResolvedValue({ settings: { webPolicy: { allowLocalAddresses: false } } });
    vi.stubGlobal('chrome', { storage: { local: { get }, session: { get: vi.fn().mockResolvedValue({}) } } });
    expect((await loadWebPolicy()).allowLocalAddresses).toBe(false);
    expect((await loadWebPolicy()).allowPrivateAddresses).toBe(true);
    expect(get).toHaveBeenCalledWith('settings');
    expect((await loadConfig()).webPolicy?.allowLocalAddresses).toBe(false);
  });
  it('extracts explicit localhost, IP and file goals using the configured policy', () => {
    expect(siteTargets('打开 http://localhost:3000/settings')).toEqual(['http://localhost:3000/settings']);
    expect(siteTargets('打开 http://192.168.1.1/')).toEqual(['http://192.168.1.1/']);
    expect(siteTargets('打开 file:///C:/demo/page.html', normalizeWebPolicy({ allowedSchemes: ['file'] }))).toEqual(['file:///C:/demo/page.html']);
  });
});
