import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Each folder under src runs in a different context. Content scripts run inside untrusted web pages
 * and the background is a service worker, so neither may pull in agent or UI code; shared code and
 * storage stay independent of every context that uses them. UI pages talk to the background and
 * content scripts only through extension messages, and with the code sandbox only through frame messages.
 */
const FORBIDDEN: Record<string, string[]> = {
  content: ['agent', 'ui', 'background', 'storage', 'sandbox'],
  background: ['agent', 'ui', 'content', 'sandbox'],
  agent: ['ui', 'content', 'background', 'sandbox'],
  storage: ['agent', 'ui', 'content', 'background', 'sandbox'],
  shared: ['agent', 'ui', 'content', 'background', 'storage', 'sandbox'],
  i18n: ['agent', 'ui', 'content', 'background', 'storage', 'shared', 'sandbox'],
  ui: ['content', 'background', 'sandbox'],
  // Runs untrusted code in an opaque origin and only exchanges frame messages with the task page.
  sandbox: ['agent', 'ui', 'content', 'background', 'storage', 'shared', 'i18n'],
};
const src = path.resolve(__dirname, '../../src');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
const layerOf = (file: string) => path.relative(src, file).split(path.sep)[0];
const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const hosts = new Set(['chrome', 'indexedDB', 'window', 'document', 'navigator']);

function inspect(source: ts.SourceFile) {
  const imports: string[] = []; const hostAccess: string[] = [];
  const visit = (node: ts.Node) => {
    let spec: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) spec = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) spec = node.argument.literal;
    if (spec && ts.isStringLiteralLike(spec)) imports.push(spec.text);
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression)) {
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '';
      if (hosts.has(node.expression.text) || node.expression.text === 'globalThis' && hosts.has(member)) hostAccess.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, hostAccess };
}

describe('source layout', () => {
  it('keeps the agent workflow and adapters independent of concrete hosts', () => {
    const modules = ['agent', 'state', 'ports', 'context', 'tools'];
    const forbidden = /^(?:\.\.\/storage\/|\.\/(?:extension-agent|runner|checkpointer|code-runner|images)$)/;
    for (const module of modules) {
      const { imports, hostAccess } = inspect(parse(path.join(src, 'agent', module + '.ts')));
      expect(imports.filter(spec => forbidden.test(spec)), module).toEqual([]);
      expect(hostAccess, module).toEqual([]);
    }
  });
  it('keeps shared rules free of direct browser and persistence access', () => {
    for (const file of files(path.join(src, 'shared'))) expect(inspect(parse(file)).hostAccess, path.relative(src, file)).toEqual([]);
  });
  it('keeps imports between context folders in the allowed direction', () => {
    const violations = files(src).flatMap(file => inspect(parse(file)).imports.filter(spec => spec.startsWith('.'))
      .map(spec => ({ file: path.relative(src, file), spec, target: layerOf(path.resolve(path.dirname(file), spec)) }))
      .filter(({ file, target }) => FORBIDDEN[layerOf(path.join(src, file))]?.includes(target)));
    expect(violations).toEqual([]);
  });
  it('has no source files outside the context folders', () => {
    expect(files(src).map(layerOf).filter(layer => !(layer in FORBIDDEN))).toEqual([]);
  });
});
