import { openDB } from 'idb';
import { skillDraftSchema, type Skill, type SkillDraft } from '../shared/skills';
import { LocalizedError } from '../i18n';

// Independent of task deletion and task database schema resets.
const database = () => openDB('bwai-skills', 1, {
  upgrade(db) { db.createObjectStore('skills', { keyPath: 'id' }); },
});
export async function listSkills(): Promise<Skill[]> {
  const db = await database();
  try { return (await db.getAll('skills') as Skill[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  finally { db.close(); }
}
export async function getSkill(id: string): Promise<Skill | undefined> {
  const db = await database();
  try { return await db.get('skills', id); } finally { db.close(); }
}
export async function saveSkill(draft: SkillDraft, source: { sourceTaskId: string; sourceTurn: number }, previous?: Skill): Promise<Skill> {
  const parsed = skillDraftSchema.safeParse(draft);
  if (!parsed.success) throw new LocalizedError('skills.invalid');
  const db = await database();
  try {
    const tx = db.transaction('skills', 'readwrite');
    const current = previous ? await tx.store.get(previous.id) as Skill | undefined : undefined;
    if (previous && current?.version !== previous.version) { await tx.done; throw new LocalizedError('skills.conflict'); }
    const at = new Date().toISOString();
    const skill: Skill = { ...parsed.data, id: current?.id ?? crypto.randomUUID(), version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? at, updatedAt: at, sourceTaskId: current?.sourceTaskId ?? source.sourceTaskId, sourceTurn: current?.sourceTurn ?? source.sourceTurn };
    await tx.store.put(skill); await tx.done; return skill;
  } finally { db.close(); }
}
export async function deleteSkill(id: string) {
  const db = await database();
  try { await db.delete('skills', id); } finally { db.close(); }
}
