---
name: add-project
description: Register the current directory as a Fantom MCP project and index it (addFantomProject, refreshFantomProject). Use when the session context says the directory is not registered.
---

Register `${CLAUDE_PROJECT_DIR}` with the Fantom MCP server.

Steps:

1. `ToolSearch("fantom", 30)` if the Fantom tools are not loaded yet.
2. Call `listFantomProjects` and check that no project already has this path
   or a parent of it. If one does, stop and tell the user its name and id.
3. Pick the language: `fantom` when the directory has `build.fan`, `fan/` or
   `.fan`, `.axon`, `.trio`, `.xeto` files; else the main language of the repo
   (`typescript`, `javascript`, `python`, `java`, `dart`, `php`). Pick the name
   from the directory name (or `podName` in `build.fan`).
4. Ask the user to confirm name, path and language in one line. Then call
   `addFantomProject` with `name`, `path` = `${CLAUDE_PROJECT_DIR}`,
   `language`, `autoIndex: true`.
5. Call `refreshFantomProject` for the new project id and wait for it.
6. Lazy indexing (watch git commits) is a server setting the MCP tools cannot
   change. Tell the user: add the new id to `indexing.lazy.projects` in
   `config/fantomMcpServer-config.json` of the mcpfantom repo, or set it to
   `"all"`.
7. Run the doctor so the plugin's project cache picks up the new project:
   `node "${CLAUDE_SKILL_DIR}/../../bin/doctor.mjs" --cwd "${CLAUDE_PROJECT_DIR}"`.
