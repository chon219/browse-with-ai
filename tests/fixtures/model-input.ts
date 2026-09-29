import type { ChatMessage } from '../../src/agent/model';

/** Fixture view of the native provider transcript. Assertions still inspect
 * the wire messages directly where call/result integrity matters. */
export function modelInput(body: { messages: { role: string; content: unknown; tool_calls?: ChatMessage['tool_calls']; tool_call_id?: string }[] }) {
  const text = (message: { content: unknown }) => Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : typeof message.content === 'string' ? message.content : '';
  const context = JSON.parse(text(body.messages[1]));
  const observations: ReturnType<typeof JSON.parse>[] = [];
  const conversation: { role: string; content: string; attachments?: unknown }[] = [];
  for (let i = 2; i < body.messages.length; i++) {
    const message = body.messages[i];
    if (message.role === 'tool') {
      const call = body.messages[i - 1].tool_calls?.find(call => call.id === message.tool_call_id);
      if (!call) throw new Error('Orphaned tool result in provider request');
      let args: unknown; try { args = JSON.parse(call.function.arguments); } catch { args = call.function.arguments; }
      observations.push({ ...JSON.parse(text(message)), action: { tool: call.function.name, arguments: args } });
    } else if (message.role === 'user') {
      let value; try { value = JSON.parse(text(message)); } catch { /* A normal user message. */ }
      if (value?.agentFeedback) observations.push({ kind: 'note', text: value.agentFeedback });
      else {
        const [content, attachments] = text(message).split('\nAttached workspace files: ');
        conversation.push({ role: 'user', content, ...(attachments ? { attachments: JSON.parse(attachments) } : {}) });
      }
    } else if (message.role === 'assistant' && !message.tool_calls) conversation.push({ role: 'assistant', content: text(message) });
  }
  const users = conversation.filter(message => message.role === 'user');
  let first = -1;
  for (let i = 0; i < users.length; i++) if (users[i].content === context.goal || users[i].content.startsWith(context.goal + '\nAttached workspace files:')) first = i;
  return { ...context, observations, conversation, instructions: users.slice(first + 1).map(message => ({ text: message.content })) };
}
