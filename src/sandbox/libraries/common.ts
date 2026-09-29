/**
 * Each library bundle (lib-*.js) is loaded into a sandbox worker with importScripts. It defines the
 * library's global for agent code and bwaiConvert, which extracts a document's text for read_file.
 */
export interface ConvertLimits { pages: number; chars: number }
export type Converter = (bytes: Uint8Array, limits: ConvertLimits) => Promise<string>;

export function register(name: string, library: unknown, convert: Converter) {
  Object.assign(globalThis, { [name]: library, bwaiConvert: convert });
}
/** Keep extracted text within the limit, saying so when some was left out. */
export const clip = (text: string, chars: number) => text.length > chars ? text.slice(0, chars) + `\n(Text after ${chars} characters was left out.)` : text;
