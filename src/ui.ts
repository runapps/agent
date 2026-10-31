// @runappsai/agent/ui — the chat UI for web pages: `renderChat`, the
// dropdown (`selectBox`, `enhanceSelect`), the theme tokens, the Markdown
// renderer, the virtual list, and `directoryFS` (a folder the user picks
// in the browser as the workspace's directory). It runs on the core
// (`@runappsai/agent`), which it imports rather than bundles.

export { renderChat, enhanceSelect, type ChatOptions, type ChatHandle } from "./chat.js";
export { selectBox, type SelectBox, type SelectOption as SelectBoxOption } from "./select.js";
export { VirtualList, type VRow, type VListOptions } from "./vlist.js";
export { CHAT_PALETTES, CHAT_COLOR_TOKENS, CHAT_SHARED_TOKENS, type ChatPalette, type ChatVars, type ChatToken, type ChatColorToken } from "./chat-theme.js";
export { renderMarkdown, renderInline, escapeHTML } from "./markdown.js";
export { directoryFS } from "./directory-fs.js";
