import { z } from 'zod';

export const skillDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(12000),
}).strict();
export type SkillDraft = z.infer<typeof skillDraftSchema>;
export interface Skill extends SkillDraft {
  id: string; version: number; createdAt: string; updatedAt: string;
  sourceTaskId: string; sourceTurn: number;
}
export function skillMarkdown(skill: SkillDraft): string {
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
}
