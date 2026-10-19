---
name: impact
description: Blast radius of a symbol before you change it - callers, depth, affected files (getCallers + getCodeImpact). Usage - /fantom-mcp:impact connExt::ConnTuning.pollTime
argument-hint: <qualifiedName like pod::Type.method>
---

Find what depends on this symbol before anyone edits it:

> $ARGUMENTS

Steps:

1. `ToolSearch("fantom", 30)` if the Fantom tools are not loaded yet.
2. Take the `projectId` from the session context. If the argument is not a
   full qualified name, resolve it first with `searchFantomCode` (`query` =
   the argument, that `projectId`) and use the best match.
3. Call `getCallers` (`qualifiedName`, `projectId`, `maxDepth: 3`).
4. Call `getCodeImpact` (`qualifiedName`, `projectId`).
5. Report a short list: direct callers (file:line), callers of callers, and
   the files that a change would touch. Mark test files separately. End with
   one line: safe to change, or needs care, and why.
