# API reference

Everything `@runappsai/agent` exports (the browser build puts it all on `window.RunAppsAgent`).

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

Options: `id`, `project`, `dir`, `skills`, `skillsDir`, `userSkills`, `userSkillsDir`, `fetch`, `indexedDB`, `inflate`.

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
| `directoryFS(handle, { description?, readonly? })` | A File System Access folder as an `AgentFS`. |
| `listTemplates(workspace)`, `expandSlash(workspace, text)` | Prompt templates. |
| `parseSkill(text, path)`, `parseFrontmatter(text)`, `skillFoldersOf(paths, name)`, `skillZipFS(...)`, `subFS(fs, base)` | Skill helpers. |
| `normalizePath(path)` | `/a/../b//c` → `/b/c`. |
| `configurePdf({ url?, workerUrl?, load? })`, `extractPdfText(bytes)`, `formatPdfText(path, result)`, `isPdf(path, type?, data?)` | PDFs. |
| `DEFAULT_SKILLS_DIR`, `DEFAULT_USER_SKILLS_DIR` | `/.agent/skills`, `/skills`. |
| types | `AgentFS`, `FileStat`, `Skill`, `SkillSource`, `LazySkill`, `WorkspaceOptions`, `WorkspaceRead`, `WorkspaceChange`, `SessionStore`, `SessionData`, `SessionSummary`, `RunEnd` |

## Chat UI — [guide](chat-ui.md)

| Export | |
|---|---|
| `renderChat(element, options)` → `ChatHandle` | The chat. |
| `selectBox(host, { options, value, filterAt?, placeholder?, filterLabel? })` → `SelectBox` | The dropdown. |
| `enhanceSelect(select, host)` → `SelectBox` | Give a `<select>` the dropdown's look. |
| `VirtualList` | The transcript's virtual list. |
| `renderMarkdown(text)`, `renderInline(text)`, `escapeHTML(text)` | The Markdown renderer. |
| `CHAT_PALETTES`, `CHAT_COLOR_TOKENS`, `CHAT_SHARED_TOKENS` | Theming. |
| types | `ChatOptions`, `ChatHandle`, `ChatPalette`, `ChatVars`, `ChatToken`, `ChatColorToken`, `SelectBox`, `VRow`, `VListOptions` |

## Lower level

| Export | |
|---|---|
| `collectCompletion(stream, params, opts)` | Gathers a streamed completion (text, thinking, tool calls). |
| `buildSystemPrompt(input)`, `estimateTokens(messages)`, `fitBudget(...)`, `groupTurns(...)` | Context building. |
| `planCut(messages, keepRecentTokens)`, `serializeConversation(messages)`, `summaryOf(message)` | Compaction. |
| `applyEdits(text, edits)`, `normalizeForFuzzyMatch(text)` | The edit matching of `edit_file`. |
| `parseCommandArgs(text)`, `substituteArgs(template, args)` | Template arguments. |
| `listZip(bytes)`, `readZipEntry(bytes, entry)`, `buildZip(entries)` | Zip files. |
