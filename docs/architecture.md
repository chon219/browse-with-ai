# Architecture

[Overview](../README.md) · [Development](development.md) · [DOM snapshots](dom-snapshot.md)

## Runtime

```text
Side panel / task page
  → LangChain agent + LangGraph checkpoints
    → Browser tools → background worker → content scripts
    → Workspace tools → local files
    → JavaScript tools → sandbox workers
```

The task page runs the agent and owns its execution lifecycle. The background worker manages tabs and browser operations. Content scripts capture pages and act on DOM elements. React renders conversations, settings, files, and the skill library.

## Modules

| Directory | Responsibility |
| --- | --- |
| `src/agent/` | Model requests, prompts, tool dispatch, context, notes, and checkpoints |
| `src/background/` | Extension events, tab ownership, navigation, approvals, and page evidence |
| `src/content/` | Semantic DOM snapshots and page interaction |
| `src/storage/` | Conversations, operations, settings, skills, logs, and workspace files |
| `src/shared/` | Types, schemas, settings, usage accounting, and browser rules |
| `src/ui/` | Extension pages, React components, attachments, previews, and styles |
| `src/sandbox/` | JavaScript execution and document libraries |
| `src/i18n/` | English and Simplified Chinese translations |

## Agent execution

`agent.ts` builds the LangChain agent. `extension-agent.ts` supplies storage, model, tool, and checkpoint adapters through the interfaces in `ports.ts`. `runner.ts` coordinates execution and cancellation.

`context.ts` assembles user messages, page observations, images, working notes, and selected skills. `tools.ts` registers browser, workspace, and code tools. Model requests use Chat Completions through `ChatOpenAI`.

LangGraph checkpoints retain execution state. IndexedDB stores conversations and operation records, while the Origin Private File System stores attachments, page evidence, and generated files. Settings and API keys use Chrome extension storage.

## Skills and resources

`skill-draft.ts` turns completed-task evidence into an editable workflow. `storage/skills.ts` stores saved skills separately from conversations. Each conversation retains its selected skill version, and `load_skill` adds its instructions to the agent context.

`page-resources.ts` groups saved Markdown snapshots by page URL. The interface shows page titles, source links, and snapshot versions alongside the conversation's workspace files.

## Build

`vite.config.ts` builds the extension pages. `scripts/build.mjs` also bundles the service worker, content script, sandbox, and document libraries. `public/manifest.json` defines the extension entry points and permissions.
