/** An in-memory stand-in for the origin private file system, covering what src/storage/workspace.ts uses. */
const notFound = () => new DOMException('missing', 'NotFoundError');
const mismatch = () => new DOMException('wrong kind', 'TypeMismatchError');
let clock = Date.parse('2026-01-01T00:00:00Z');

const join = (a: Uint8Array, b: Uint8Array) => { const joined = new Uint8Array(a.byteLength + b.byteLength); joined.set(a); joined.set(b, a.byteLength); return joined; };
class FakeFile {
  readonly kind = 'file';
  data = new Uint8Array(); lastModified = clock;
  constructor(readonly name: string) {}
  async getFile() {
    const data = this.data;
    return { size: data.byteLength, lastModified: this.lastModified, text: async () => new TextDecoder().decode(data), arrayBuffer: async () => data.slice().buffer };
  }
  async createWritable({ keepExistingData = false } = {}) {
    let buffer = keepExistingData ? this.data : new Uint8Array();
    return {
      seek: async () => {},
      write: async (content: string | Blob) => { buffer = join(buffer, typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(await content.arrayBuffer())); },
      close: async () => { this.data = buffer; this.lastModified = clock += 1000; },
    };
  }
}
class FakeDirectory {
  readonly kind = 'directory';
  readonly children = new Map<string, FakeDirectory | FakeFile>();
  constructor(readonly name: string) {}
  async getDirectoryHandle(name: string, { create = false } = {}) {
    const entry = this.children.get(name);
    if (entry instanceof FakeFile) throw mismatch();
    if (entry) return entry;
    if (!create) throw notFound();
    const directory = new FakeDirectory(name); this.children.set(name, directory); return directory;
  }
  async getFileHandle(name: string, { create = false } = {}) {
    const entry = this.children.get(name);
    if (entry instanceof FakeDirectory) throw mismatch();
    if (entry) return entry;
    if (!create) throw notFound();
    const file = new FakeFile(name); this.children.set(name, file); return file;
  }
  async removeEntry(name: string) { if (!this.children.delete(name)) throw notFound(); }
  async *entries() { yield* this.children.entries(); }
}

/** Install a fresh fake file system as `navigator.storage` and return its root. */
export function fakeFileSystem(stub: (name: string, value: unknown) => void) {
  const root = new FakeDirectory('');
  const { navigator } = globalThis;
  stub('navigator', { ...navigator, locks: navigator.locks, storage: { getDirectory: async () => root } });
  return root;
}
