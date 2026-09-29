import { useEffect, useState } from 'react';
import { listFiles, onWorkspaceChange, readFileHeader } from '../storage/workspace';
import { archiveSource, isPageArchive, type ResourceFile } from './page-resources';

/** One live file list shared by the resource browser and conversation links. */
export function useWorkspaceFiles(taskId: string) {
  const [files, setFiles] = useState<ResourceFile[]>([]);
  useEffect(() => {
    let sequence = 0;
    let cached = new Map<string, ResourceFile>();
    const refresh = () => {
      const run = ++sequence;
      void listFiles(taskId).then(found => Promise.all(found.map(async file => {
        const old = cached.get(file.path);
        if (old && old.size === file.size && old.modifiedAt === file.modifiedAt) return old;
        if (!isPageArchive(file.path)) return file;
        try { return { ...file, page: archiveSource(file.path, await readFileHeader(taskId, file.path)) }; }
        catch { return file; }
      }))).then(found => {
        if (run !== sequence) return;
        cached = new Map(found.map(file => [file.path, file])); setFiles(found);
      }, () => { if (run === sequence) setFiles([]); });
    };
    const stop = onWorkspaceChange(taskId, refresh);
    refresh();
    return () => { sequence++; stop(); };
  }, [taskId]);
  return files;
}
