# DOM Snapshots

[Overview](../README.md) · [Architecture](architecture.md)

Content scripts read page structure through DOM APIs. `dom-accessibility-api` supplies accessible names and roles, and Chrome's shadow-root API exposes Shadow DOM content.

```text
DOM and Shadow DOM
  → Semantic nodes and control references
  → Combined frame tree
  → Model context and Markdown evidence
```

## Capture and actions

`src/content/dom-snapshot.ts` collects rendered headings, lists, tables, text, and controls. It follows distributed slots and retains the relationship between content and nearby actions.

`src/content/content.ts` describes field values and options, binds control references to DOM nodes, and executes browser actions. Each read creates a snapshot with references used by subsequent tool calls.

## Page composition

`src/background/page-snapshot.ts` combines frame snapshots at their host positions and prepares page text, viewport text, and controls for the model. `src/background/page-tools.ts` routes reads and actions to the appropriate document.

The `read` tool provides page observations and control pagination. `read_element` retrieves labels, values, and options in detail.

## Evidence

Page content is saved as Markdown in the conversation workspace at `pages/<content-hash>.md`. Evidence retains headings, text, tables, the source URL, and page title. Identical content shares the same file.

The interface groups these files by source page and provides links, previews, and snapshot history. Agent observations include the evidence path for later reading and analysis.
