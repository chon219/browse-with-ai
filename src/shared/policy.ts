/** What the agent may ask the executor to do: the tool action schema and which navigations need approval. */
import { z } from 'zod';
import { MESSAGE_CHARS } from './tuning';
const tab = z.number().int().positive();
const reference = { tabId: tab, snapshotId: z.string().min(1).max(100), elementId: z.string().min(1).max(40) };
/** The model declares effects, the executor enforces confirmations. */
const intent = {
  effect: z.enum(['read', 'write', 'irreversible']).optional().describe('What this step does to site data: read (only views, filters, navigates), write (saves, sends, submits or changes data), irreversible (payment, deletion, anything that cannot be undone). When unsure, use write.'),
  reason: z.string().trim().max(300).optional().describe('One sentence for the user on what this step does, shown on the confirmation card.'),
};
export const actionSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('list_tabs') }).strict(),
  z.object({ name: z.literal('switch_tab'), tabId: tab }).strict(),
  z.object({ name: z.literal('back'), tabId: tab }).strict(),
  z.object({ name: z.literal('wait'), tabId: tab, milliseconds: z.number().int().min(100).max(5000) }).strict(),
  z.object({ name: z.literal('check'), ...reference, checked: z.boolean(), ...intent }).strict(),
  z.object({ name: z.literal('search'), query: z.string().trim().min(1).max(300) }).strict().describe('General web search for discovery, an explicit web-search request, or locating an unknown official address. For a named or known website, open it and use its own search first; this action does not search within that website.'),
  z.object({ name: z.literal('fill'), ...reference, value: z.string().max(MESSAGE_CHARS), ...intent }).strict(),
  z.object({ name: z.literal('click'), ...reference, ...intent }).strict(),
  z.object({ name: z.literal('select'), ...reference, value: z.string().max(300), ...intent }).strict(),
  z.object({ name: z.literal('open'), url: z.string().max(2048), ...intent }).strict(),
  z.object({ name: z.literal('read'), tabId: tab, frameId: z.number().int().nonnegative().optional(), elementOffset: z.number().int().nonnegative().optional() }).strict(),
  z.object({ name: z.literal('read_element'), ...reference, part: z.enum(['label', 'value', 'options']), offset: z.number().int().nonnegative().optional() }).strict(),
  z.object({ name: z.literal('follow'), ...reference, ...intent }).strict(),
  z.object({ name: z.literal('scroll'), tabId: tab, direction: z.enum(['up', 'down']) }).strict(),
  z.object({ name: z.literal('close'), tabId: tab }).strict(),
]);
/** Whether the model itself predicts that a step writes or changes data. */
export const declaresEffect = (action: { effect?: string }) => !!action.effect && action.effect !== 'read';
