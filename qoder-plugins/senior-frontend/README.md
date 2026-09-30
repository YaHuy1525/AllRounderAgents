# Senior Frontend — Qoder Plugin

Qoder-native plugin package for the `senior-frontend` skill: a frontend
development toolkit for modern React, Next.js, TypeScript, and Tailwind CSS
projects, covering component scaffolding, performance optimization, bundle
analysis, and UI best practices.

## Components

- **Skill**: `senior-frontend` (`skills/senior-frontend/SKILL.md`)
  - `references/react_patterns.md` — React patterns and anti-patterns
  - `references/nextjs_optimization_guide.md` — Next.js optimization workflow
  - `references/frontend_best_practices.md` — frontend best-practices reference
  - `scripts/component_generator.py` — component scaffolding helper
  - `scripts/bundle_analyzer.py` — bundle analysis helper
  - `scripts/frontend_scaffolder.py` — frontend scaffolding helper

No rules, agents, commands, hooks, or MCP servers are declared.

## Source Provenance

- Requested source: <https://app.aitmpl.com/component/skill/development/senior-frontend>
- Upstream repository: <https://github.com/davila7/claude-code-templates>
- Upstream path: `cli-tool/components/skills/development/senior-frontend` (branch `main`, fetched 2026-09-23)
- All skill content (`SKILL.md`, `references/`, `scripts/`) was copied unmodified from upstream. The original frontmatter (`name: senior-frontend`, `description: ...`) is preserved.

## Omitted Files

- None. The upstream skill directory contained exactly the seven files listed
  above, and all were copied.
- Upstream ships no logo file; `assets/avatar.svg` is a locally generated
  fallback (monogram "SF"). No remote artwork was downloaded.

## Content Quality Note

The upstream reference documents and Python scripts are scaffold-level
templates: the docs use generic placeholders ("Pattern 1", "Scenario 1") and
the scripts are standard CLI skeletons whose `analyze()` methods contain no
domain logic yet. They were preserved as-is for provenance; treat them as
starting scaffolds, not deep guidance. The SKILL.md workflow and trigger
description are the primary value of this skill.

## Project-Local Activation

This package is intended to live at `<repo>/qoder-plugins/senior-frontend/`.
A repo-local junction is kept at `.qoder/skills/senior-frontend` pointing to
`qoder-plugins/senior-frontend/skills/senior-frontend`, so Qoder discovers the
skill in this project immediately without duplicating `SKILL.md`. The `.qoder/`
directory is gitignored in this repository.

## Install For All Projects

Install the plugin root as a local Qoder plugin, using the Plugins panel
(local install option) or, when `qodercli` is available:

```bash
qodercli plugin install --scope local "<abs-path-to>/qoder-plugins/senior-frontend"
```

## Setup Notes

- No credentials, tokens, or MCP endpoints are required.
- The helper scripts require Python 3. Run them from the skill directory, e.g.
  `python scripts/bundle_analyzer.py .` or
  `python scripts/component_generator.py <project-path> --verbose`.

## Validation

Offline validator (bundled with the `create-plugin` skill):

```
python ".../create-plugin/scripts/validate_qoder_plugin.py" "d:\Code\AllRounderAgent\qoder-plugins\senior-frontend"
Validating Qoder plugin: D:\Code\AllRounderAgent\qoder-plugins\senior-frontend
OK: no issues found
```

- Alias check: reading `.qoder/skills/senior-frontend/SKILL.md` through the
  junction returns the expected frontmatter (`name: senior-frontend`), and
  support files resolve through the alias.
- No `qodercli` install smoke test was run: `qodercli` is not available on
  this machine.
