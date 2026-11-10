# Skills

Skills are reusable workflow bundles for procedures that need judgement. They
follow Anthropic's Agent Skills (SKILL.md) standard. They are distinct from
executable scripts and from factual memory.

## Storage

- Scripts: executable programs in `workspace/scripts/`, created with
  `save_script`, run with `run_script`.
- Skills: SKILL.md bundles in `workspace/skills/<name>/SKILL.md`, created with
  `save_skill`, selected with `find_skills`, loaded with `read_skill`.
- Facts, preferences, and history: `memory/memory.md`, MemPalace, and daily
  notes, not skills.

### Skill layout (SKILL.md standard)

Each skill is a **folder** under `workspace/skills/<name>/` whose entry file is
`SKILL.md`:

```
workspace/skills/<name>/
  SKILL.md          # YAML frontmatter + markdown body
  helper.py         # optional bundled resource
  template.md       # optional bundled resource
```

`SKILL.md` opens with YAML frontmatter. Required keys are `name` and
`description`; optional keys (e.g. `license`, `metadata`, `allowed-tools`) are
tolerated and preserved on read. The markdown body follows the closing `---`.

```markdown
---
name: review-pr
description: review pull requests carefully
---

## Steps

1. Read the diff.
2. Run tests.
```

**Bundled resources.** A skill folder may contain supporting files (scripts,
templates, references) alongside `SKILL.md`. `save_skill` overwrites only
`SKILL.md` and never touches sibling files, so updates preserve bundled
resources. `read_skill` enumerates them and tells the agent to open them with
the normal Read tool. Deleting a skill removes the whole folder.

## CLI management

`talon skill` manages the store from the outside — the agent-facing tools
(`save_skill`, `find_skills`, `read_skill`) are unchanged:

- `talon skill install <source>` — install from a local folder, a git URL, or
  `owner/repo[/subpath]` GitHub shorthand (so
  `talon skill install anthropics/skills/document-skills/pdf` works). The
  source either **is** a skill (has `SKILL.md`) or is a collection whose
  immediate children are skills — collections install every child. The target
  folder name is the frontmatter `name`; existing skills are only replaced
  with `--force`. A git source installs at a given commit with `<source>#<sha>`
  or `--commit <sha>`, and each skill installed from git gets a
  `.talon-install.json` recording the repo, path and commit (it is not listed
  as a skill resource).
- `talon skill list` — every skill with its enabled state.
- `talon skill enable/disable <name>` — toggle via a `.disabled` marker file
  in the skill folder. The marker survives `save_skill` updates (which only
  rewrite `SKILL.md`). Disabled skills drop out of the prompt index and
  `find_skills`, but stay listable via `list_skills` (shown `[disabled]`) and
  readable via `read_skill` — the toggle hides, it never restricts.
- `talon skill remove <name>` — delete the skill folder.

Installs and toggles need no daemon restart: the prompt index re-reads the
store on the next prompt assembly.

## Loading Policy

The system prompt injects only a capped skill index: name, description, and
updated date. Full bodies stay on disk until needed.

Agents should:

1. Use the prompt index when the relevant workflow is obvious.
2. Use `find_skills` when the task needs relevance selection.
3. Call `read_skill` before following a selected workflow.
4. Create or update a skill when a repeatable process is learned.

This keeps startup context small while preserving progressive disclosure.

## Backend Adapter Model

Talon does not depend on provider-native skill support. The adapter layer is the
shared prompt and shared gateway tools:

- Claude SDK receives the skill index after the dynamic cache boundary and
  exposes the same MCP tools.
- Codex receives the same prompt text and tool definitions through its MCP
  server config.
- Kilo and OpenCode receive the same prompt and shared gateway actions through
  the remote-server backend path.
- OpenAI Agents receives the same prompt and tool surface through the Responses
  backend.

If a backend later gains native skills, it can mirror
`workspace/skills/<name>/SKILL.md` into that native format, but the SKILL.md
store remains the source of truth so workflows are portable across backends.

## Migration Boundary

`save_script` entries remain executable scripts. Do not auto-convert them:
scripts encode deterministic subprocess behavior, while skills encode
review/checklist/debugging guidance. A script can reference a skill in its
description, and a skill can tell the agent to run a script, but they stay
separate artifacts.
