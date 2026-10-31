# API reference

Three entry points:

| Import | |
|---|---|
| `@runappsai/agent` | The core — everything below except the last two sections. No DOM: browsers, Node, Deno, workers. |
| `@runappsai/agent/ui` | The chat UI and browser helpers ([Chat UI](#chat-ui--guide) below). |
| `@runappsai/agent/node` | Node helpers ([Node](#node--guide) below). |
| `@runappsai/agent/browser` | `agent.umd.js`: the core and the UI as one script, on `window.RunAppsAgent` (`/browser/core`: the core alone). |

## Providers — [guide](providers.md)

| Export | |
|---|---|
| `openAIProvider({ baseURL, apiKey?, headers?, models?, streamUsage?, fetch?, name? })` | Any OpenAI-compatible API. |
| `runappsProvider(client)` | The RunApps SDK client. |
| `toProvider(providerOrClient)` | A provider as is, a RunApps client wrapped. |
| `ProviderError(status, message, { code?, retryAfter? })` | Throw from your provider; 408 / 429 / 5xx / 0 are retried. |
| `sseData(body, signal?)` | Yields the `data:` payloads of a server-sent event stream. |
| types | `ModelProvider`, `ModelInfo`, `OpenAIProviderOptions`, `RunAppsClientLike`, `ChatMessage`, `ContentPart`, `ChatTool`, `ChatToolCall`, `ChatCompletionParams`, `ChatCompletionChunk`, `ChatCompletion`, `Usage` |

## Agent — [guide](agent.md)

`createAgent(provider, options)` → `Agent` (also `new Agent(provider, options)`).

| Member | |
|---|---|
| `prompt(content, { signal })` | Start a run (queued as a follow-up while one is running). → `RunResult` |
| `steer(content)` | Insert into the running run (starts one when idle). |
| `followUp(content)` | Run after the current run. → `RunResult` |
| `continue()` | Carry on without a new message. → `RunResult` |
| `abort()` | Stop the run. |
| `rewind(index)` | Drop the messages from `index` on. |
| `compact(focus?)` | Summarise older turns now. → `boolean` |
| `queued`, `dequeue(message)`, `clearQueue()` | What waits. |
| `on(event, handler)` / `on("*", (name, event) => …)` | Subscribe; returns an unsubscribe function. |
| `ready()` | Resolves once a saved session is loaded. |
| `configure(patch)`, `settings` | `model`, `maxTurns`, `maxTokens`, `permissions`, `reasoningEffort`. |
| `limits()` → `{ input, output }`, `context()` → `{ used, window }` | Model limits, context use. |
| `useSkill(name)` | Load a skill for the next prompt. |
| `systemPrompt()` | The system prompt as it would be sent. |
| `export()` → `SessionData`, `reset()` | Save / forget the conversation. |
| `messages`, `usage`, `busy`, `model`, `id`, `provider`, `workspace`, `tools`, `ui`, `lastEnd` | State. |

Options: see [the options table](agent.md#options). Events: see [Events](agent.md#events).

## Tools — [guide](tools.md)

| Export | |
|---|---|
| `defineTool({ name, description, parameters?, execute, destructive?, confirm?, guidelines?, maxResultChars? })` | A tool. |
| `fileTools(workspace)` | The file tools for a workspace. |
| `sandboxTool(workspace, options)`, `runInSandbox(workspace, code, input, options)` | The `run_js` sandbox. |
| `askUserTool()` | The `ask_user` tool. |
| `normalizeResult(value)` | How a tool's return value becomes the model's result. |
| `validateSchema(schema, value)` → `string[]` | The JSON Schema check used on arguments (the errors, empty when valid). |
| types | `Tool`, `ToolDefinition`, `ToolContext`, `ToolResultValue`, `ToolStatus`, `JSONSchema` |

## Dialogs

| Export | |
|---|---|
| `domUI()` | Plain `<dialog>`s (the default). |
| `nullUI()` | Declines every question. |
| types | `AgentUI` (`confirm`, `select`, `input`, `notify`), `SelectOption` |

## Workspace — [guide](workspace.md), [skills](skills.md)

`openWorkspace(provider | null, options)` → `Workspace` (also `Workspace.open(...)`).

Options: `id`, `project`, `dir`, `store`, `skills`, `skillsDir`, `userSkills`, `userSkillsDir`, `fetch`, `indexedDB`, `inflate`.

| Member | |
|---|---|
| `list(prefix)`, `stat(path)`, `exists(path)`, `isFolder(path)` | Look. |
| `read(path)` → `{ data, size, contentType }`, `readText(path)`, `readAsText(path)` | Read (PDFs as text). |
| `write(path, content, contentType?)`, `delete(path)`, `clearWork()`, `destroy()` | Change. |
| `mount(prefix, fs)`, `unmount(prefix)`, `mountOf(path)`, `isReadOnly(path)`, `isSkillPath(path)` | Mounts. |
| `onChange(fn)` | `{ path, kind, remote }` for every write and delete. |
| `getData(key)`, `putData(key, value)`, `deleteData(key)` | Your data kept with the directory. |
| `skills()`, `skillBody(name)`, `installSkill(source, { name?, unpack? })`, `removeSkill(name)`, `refreshSkills()` | Skills. |
| `sessions.list()`, `.get(id)`, `.save(data)`, `.delete(id)`, `.clear()` | Saved conversations. |
| `describe()` | What the system prompt says about the directory. |
| `close()` | Release the database (it reopens on use). |
| `id`, `dbName`, `skillsDir`, `userSkillsDir`, `root` | State. |

| Export | |
|---|---|
| `memoryFS(files, { description?, readonly? })` | An in-memory `AgentFS` to mount. |
| `listTemplates(workspace)`, `expandSlash(workspace, text)` | Prompt templates. |
| `parseSkill(text, path)`, `parseFrontmatter(text)`, `skillFoldersOf(paths, name)`, `skillZipFS(...)`, `subFS(fs, base)` | Skill helpers. |
| `normalizePath(path)` | `/a/../b//c` → `/b/c`. |
| `guessType(path, data)`, `decodeText(bytes)` | A content type from a name; UTF-8 text or null. |
| `titleOf(session)`, `UNTITLED` | A session's title (the user's first words). |
| `configurePdf({ url?, workerUrl?, load? })`, `extractPdfText(bytes)`, `formatPdfText(path, result)`, `isPdf(path, type?, data?)` | PDFs. |
| `DEFAULT_SKILLS_DIR`, `DEFAULT_USER_SKILLS_DIR` | `/.agent/skills`, `/skills`. |
| types | `AgentFS`, `FileStat`, `Skill`, `SkillSource`, `LazySkill`, `WorkspaceOptions`, `WorkspaceRead`, `WorkspaceChange`, `SessionStore`, `SessionData`, `SessionSummary`, `RunEnd`, `WorkspaceStore`, `WorkspaceStoreFactory`, `FileRecord` (for a `store` of your own) |

## Lower level

| Export | |
|---|---|
| `collectCompletion(stream, params, opts)` | Gathers a streamed completion (text, thinking, tool calls). |
| `buildSystemPrompt(input)`, `estimateTokens(messages)`, `fitBudget(...)`, `groupTurns(...)` | Context building. |
| `planCut(messages, keepRecentTokens)`, `serializeConversation(messages)`, `summaryOf(message)` | Compaction. |
| `applyEdits(text, edits)`, `normalizeForFuzzyMatch(text)` | The edit matching of `edit_file`. |
| `parseCommandArgs(text)`, `substituteArgs(template, args)` | Template arguments. |
| `listZip(bytes)`, `readZipEntry(bytes, entry)`, `buildZip(entries)` | Zip files. |

## Chat UI — [guide](chat-ui.md)

From `@runappsai/agent/ui`.

| Export | |
|---|---|
| `renderChat(element, options)` → `ChatHandle` | The chat. |
| `selectBox(host, { options, value, filterAt?, placeholder?, filterLabel? })` → `SelectBox` | The dropdown. |
| `enhanceSelect(select, host)` → `SelectBox` | Give a `<select>` the dropdown's look. |
| `VirtualList` | The transcript's virtual list. |
| `renderMarkdown(text)`, `renderInline(text)`, `escapeHTML(text)` | The Markdown renderer. |
| `CHAT_PALETTES`, `CHAT_COLOR_TOKENS`, `CHAT_SHARED_TOKENS` | Theming. |
| `directoryFS(handle, { description?, readonly? })` | A folder the user picked (File System Access API) as an `AgentFS`. |
| types | `ChatOptions`, `ChatHandle`, `ChatPalette`, `ChatVars`, `ChatToken`, `ChatColorToken`, `SelectBox`, `VRow`, `VListOptions` |

## Node — [guide](node.md)

From `@runappsai/agent/node` (Node 18+).

| Export | |
|---|---|
| `nodeFS(folder, { description?, readonly?, ignore? })` | A folder on disk as an `AgentFS` (`dir`). |
| `nodeStore(folder?)` → `WorkspaceStoreFactory` | The workspace's storage on disk (`store`); default `~/.runapps-agent`. |
| `terminalUI({ input?, output?, rl?, ask? })` → `AgentUI` | Dialogs in the terminal. |
| `nodePdf()` | Read PDFs with the `pdfjs-dist` package. |
| types | `NodeFSOptions`, `TerminalUIOptions` |
