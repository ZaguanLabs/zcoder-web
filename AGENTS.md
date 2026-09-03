<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

Use `pnpm`.
Goal of this project is to create a lean and fast application.

## Push and deploy

When I tell you to push and deploy, you push to git, then `ssh` to `fidelity` and use `zsh -cli` to run the scripts successfully, cd to `/shared/sites/stig/zweb` and run the script `./scripts/pm2-restart.sh`. This script pulls from git and rebuilds the project, then restarts the `pm2` process. You can also run `./scripts/pm2-restart.sh --rebuild` to only rebuild without pulling from git.

# Atlas Scout

## Code navigation

When Atlas Scout MCP tools are available, **always** use them as the primary navigation path for repository
investigations that need the correct file, source range, or structural relationship. This includes
definitions, named symbols, unknown locations, callers, references, dependency paths, architecture,
and edit impact.

- If the file and range are already known, read that range directly.
- If a file is known but the relevant range is not, use `symbol_outline` before reading the file.
- If the location is unknown, use `symbol_search`, then `symbol_resolve` when exact metadata is
  needed.
- Use `symbol_references`, `symbol_graph`, `symbol_trace`, `symbol_path`, or `edit_impact` for the
  corresponding structural question.
- Read the exact source ranges returned by Atlas Scout before drawing conclusions or editing.
- Use `rg` or other raw-text search for literals, regexes, unmodeled text, unsupported/partial
  language coverage, an explicit user request, or after focused Atlas Scout queries miss.

Do not use shell text search as the default substitute for Atlas Scout when the task is structural
code navigation.
