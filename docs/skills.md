# Skills

A skill is a folder of instructions (and optionally reference files and scripts) that the agent loads when a task calls for it — the same format as Claude Code and pi skills. Only each skill's name and description are in the system prompt; the agent reads the rest when it needs it, so a large skill costs nothing until it is used.

## A skill

```
unit-convert/
├── SKILL.md
├── references/
│   └── factors.md
└── scripts/
    └── convert.js
```

`SKILL.md` starts with frontmatter:

```markdown
---
name: unit-convert
description: Convert between units (length, mass, temperature, volume) with exact factors. Use whenever the user asks to convert a quantity, e.g. "10 lb to kg".
---
1. Read `references/factors.md` for the factor.
2. Run `scripts/convert.js` with run_js (fs.read it, pass `input = { value, factor }`).
3. Answer with the result and the factor used.
```

| Frontmatter | |
|---|---|
| `name` | Lowercase, digits and hyphens. Defaults to the folder name. |
| `description` | Required. What the skill does and when to use it — see below. |
| `disable-model-invocation: true` | The agent never picks it by itself; it runs only when asked with `/skill:name`. |
| `license`, `compatibility`, `allowed-tools`, `metadata` | Kept on the `Skill` object. |

Package skills as a zip: either `SKILL.md` at the root (one skill, named after the zip), or one folder per skill.

Scripts run only as JavaScript (`run_js`: a Worker, no shell, no Python, no network). The agent is told that a script in another language is to be read, ported to JavaScript and run that way — so a skill written with Python helpers still works when its logic is portable.

### Writing the description

The description is all the model sees before deciding to load a skill, so it decides whether the skill is ever used. Say what it does and *when*: the situations, the kinds of request, the words a user would use, in one to three sentences.

```yaml
# rarely used: a feature list
description: Novel writing engine with character, plot and dialogue tools.

# used reliably: scope, situations, user phrasing
description: Writes web-novel chapters from an outline in the genre's style (xianxia, romance, system, urban…). Use when the user gives an outline or chapter brief and asks for the text, a title, a blurb, or a rewrite ("make it punchier", "funnier").
```

Keep the first sentence self-contained, name concrete triggers, and leave the how-to for the body.

## Where skills come from

The agent reads skills from **`/.agent/skills/<name>/`**. That folder is virtual and read-only: it is generated in memory when the workspace opens (and whenever the user's skills change) from two sources.

### 1. The app's skills — the `skills` option

```js
openWorkspace(provider, {
  skills: [
    "/skills.zip",                                  // a URL or a path in your bundle
    "files:packs/design.zip",                       // RunApps: a file in the user's storage
    someFile,                                       // a Blob / File from an <input>
    { name: "review", data: zipBytes },             // bytes, with a name
  ],
});
```

They are read in place each time the page opens them — never unpacked, never stored (a URL is fetched once per page; `workspace.refreshSkills()` fetches again). The user cannot remove them (`Skill.builtin`).

### Lazy skills: load on first use

For many skills, or skills kept on your server, give each one's name and description and a way to get its zip. The zip is fetched only the first time the skill is used — when the agent reads one of its files, or the user types `/skill:name`:

```js
openWorkspace(provider, {
  // a function returning the list — sync or async — is called at open and by refreshSkills()
  skills: async () => {
    const list = await fetch("/api/skills").then((r) => r.json());
    return list.map((s) => ({
      name: s.name,
      description: s.description,
      load: () => fetch(`/api/skills/${s.name}.zip`).then((r) => r.blob()),
      // or: load: () => `/api/skills/${s.name}.zip`   (a URL is fetched for you)
    }));
  },
});
```

- Listing costs nothing: the prompt, the skills menu and the `/` menu show lazy skills without loading them (`Skill.lazy`).
- `load()` returns a Blob, ArrayBuffer, Uint8Array, or a URL / `files:` path to fetch. It runs once per page; every conversation shares the result.
- A failed load is reported to the agent ("the skill … could not be loaded: …") and tried again the next time.
- Lazy and ordinary sources can be mixed in one list.

### 2. The user's skills — `/skills/`

Unless turned off, each app has a **`/skills/`** folder shared by every conversation, visible in the chat's files panel:

- **zips** the user uploads (Skills menu → Upload zip, or `workspace.installSkill(file)`) are kept as `/skills/<name>.zip` and read in place;
- **folders** `/skills/<name>/SKILL.md` — written by the user, or by the agent when asked to make a skill (its prompt tells it where).

A user's skill with the same name as one of the app's takes its place.

```js
const added = await workspace.installSkill(file);                   // a zip File / Blob / bytes / URL → /skills/<name>.zip
await workspace.installSkill(file, { name: "my-tool", unpack: true });  // as editable files in /skills/my-tool/
await workspace.removeSkill("my-tool");                             // the user's only; the app's cannot be removed
```

### Only the app's skills

```js
openWorkspace(provider, { userSkills: false, skills: appSkills });
```

No `/skills/` folder, nothing to upload or remove (the chat's Skills menu shows neither), `installSkill` refuses, and the agent is not told it may make skills.

## Using skills

- The model loads a skill by itself when a task matches its description (unless `disable-model-invocation`).
- The user types **`/skill:name`** (with arguments after it) to use one explicitly; the chat's Skills menu puts it in the composer.
- From code: `agent.useSkill("name")` loads it for the next prompt.

```js
const skills = await workspace.skills();
// [{ name, description, path, dir, builtin?, lazy?, from?, disableModelInvocation? }]
const { body } = await workspace.skillBody("unit-convert");
```

`skillsDir` (default `/.agent/skills`) and `userSkillsDir` (default `/skills`) move the two folders.
