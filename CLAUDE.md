# CLAUDE.md

This file exists so Claude Code picks up this repository's agent instructions.
It deliberately holds no guidance of its own.

## Read AGENTS.md first

**[AGENTS.md](./AGENTS.md) is the single source of truth.** Everything that
applies to any coding agent working here lives there: the layering and how
siblings reach each other in tests, the build and the artifact check, how
releasing works, and the duplications that are deliberate.

## Skills

The skills come from the `nxgt-core` marketplace, enabled in the committed
`.claude/settings.json`: `nxgt-workflow` (`large-feature-branch-workflow`,
`write-a-repo-script`), `nxgt-package` (`create-a-package`,
`release-a-package-change`), `nxgt-docs` (`keep-docs-current`, and the
agents `documentation-auditor`, `documentation-writer`,
`troubleshooting-writer` and `roadmap-keeper`) and `nxgt-review`
(`review-before-a-pr`, and the `code-reviewer` agent, which reads
`references/nxgt-data.md`). They are authored in `softistx/nxgt-core`, under
`plugins/`; nothing is copied here, and there is no local agent.

A skill that is genuinely only about this repository goes in
`.claude/skills/<name>/SKILL.md`.

## Keeping it that way

Add new agent guidance to `AGENTS.md`, never here. This file should only ever
grow content that is genuinely Claude Code-specific.
