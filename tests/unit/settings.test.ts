import { describe, expect, it } from 'vitest';
import { endpoint } from '../../src/shared/settings';

describe('model API endpoint', () => {
  it.each(['http://localhost:11434/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1', 'http://192.168.1.10:11434/v1', 'http://10.0.0.5/v1', 'http://gpu-box/v1', 'http://llm.lan:8080/v1'])('allows HTTP on local and private addresses: %s', url => {
    expect(endpoint(url)).toBe(url + '/chat/completions');
  });
  it.each(['http://api.example.com/v1', 'http://8.8.8.8/v1'])('requires HTTPS on public addresses: %s', url => {
    expect(() => endpoint(url)).toThrow();
  });
  it('rejects credentials, queries and fragments', () => {
    for (const url of ['https://user:pw@api.example.com/v1', 'https://api.example.com/v1?x=1', 'https://api.example.com/v1#a']) expect(() => endpoint(url)).toThrow();
  });
});
