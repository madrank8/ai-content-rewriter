# AI Content Rewriter — Development Guidelines

## Project Overview

This is `@affiliate.fm/ai-content-rewriter`, an AI-powered content rewriting library using OpenAI (gpt-4.1). It includes format auto-detection and configurable prompts.

- **Language:** TypeScript (ESM)
- **Runtime:** Node.js >= 18
- **Build:** `npm run build` (tsc)
- **Entry:** `src/` → `lib/`

## Superpowers Integration

This project uses the [Superpowers](https://github.com/obra/superpowers) agentic skills framework. Skills, agents, and hooks are installed locally in:

- `skills/` — Composable skill definitions (TDD, debugging, brainstorming, planning, etc.)
- `agents/` — Agent prompt templates (code-reviewer, etc.)
- `hooks/` — Session start hooks and cross-platform wrappers

### Using Skills

**Invoke relevant skills BEFORE any response or action.** Even a 1% chance a skill applies means you should invoke it.

Priority order:
1. Process skills first (brainstorming, debugging) — these determine HOW to approach
2. Implementation skills second — these guide execution

### Key Skills Available

| Skill | When to Use |
|-------|-------------|
| `superpowers:brainstorming` | Starting any new feature or significant change |
| `superpowers:writing-plans` | Creating implementation plans |
| `superpowers:executing-plans` | Implementing from a plan |
| `superpowers:test-driven-development` | Writing or modifying code (red-green-refactor) |
| `superpowers:systematic-debugging` | Investigating bugs or failures |
| `superpowers:requesting-code-review` | After completing a feature or major step |
| `superpowers:receiving-code-review` | When review feedback is received |
| `superpowers:using-git-worktrees` | Isolating work in separate branches |
| `superpowers:finishing-a-development-branch` | Wrapping up a branch for merge |
| `superpowers:verification-before-completion` | Before declaring any task done |
| `superpowers:dispatching-parallel-agents` | Running independent tasks concurrently |
| `superpowers:subagent-driven-development` | Complex multi-step implementations |

## Development Workflow

1. **Brainstorm** before planning — refine the design through dialogue
2. **Plan** before coding — break work into granular tasks (2-5 min each)
3. **TDD** — write tests first, see them fail, then implement
4. **Review** — request code review after completing major steps
5. **Verify** — run verification before declaring anything done

## Coding Standards

- TypeScript strict mode
- ESM modules (`"type": "module"`)
- No unnecessary dependencies — keep the library lightweight
- Follow existing patterns in `src/`
