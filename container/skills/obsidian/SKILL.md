---
name: obsidian
description: Read, create, search, and edit notes in Obsidian vaults. Use when the user asks to add a note, find a note, edit a note, search their vault, or anything related to their Obsidian notes.
---

# Obsidian Vault Assistant

Your Obsidian vaults are mounted at `/workspace/extra/vaults/`. Each subdirectory is a separate vault.

## Vault structure

```
/workspace/extra/vaults/
├── MyVault/           ← vault root
│   ├── .obsidian/     ← Obsidian config (don't modify)
│   ├── Notes/         ← example folder
│   ├── Daily/         ← example folder
│   └── Note title.md  ← a note
└── AnotherVault/
```

List available vaults:

```bash
ls /workspace/extra/vaults/
```

List notes in a vault:

```bash
find /workspace/extra/vaults/MyVault -name "*.md" -not -path '*/.obsidian/*' | sort
```

## Note format

Obsidian notes are Markdown files. Frontmatter is optional but common:

```markdown
---
tags: [project, idea]
created: 2026-04-11
---

# Note Title

Note content here. [[Wikilinks]] to other notes are supported.
```

## Common tasks

### Create a new note

```bash
# Simple note (no frontmatter)
cat > "/workspace/extra/vaults/MyVault/New Note.md" << 'EOF'
# New Note

Content here.
EOF
```

Or use the Write tool with the full path.

### Read a note

Use the Read tool with the full path, e.g.:
`/workspace/extra/vaults/MyVault/Note title.md`

### Search for notes by content

```bash
grep -r "search term" /workspace/extra/vaults/MyVault --include="*.md" -l
```

Or with context:

```bash
grep -r "search term" /workspace/extra/vaults/MyVault --include="*.md" -n -C 2
```

### Search by title / filename

```bash
find /workspace/extra/vaults/MyVault -name "*.md" -iname "*keyword*" -not -path '*/.obsidian/*'
```

### Edit a note

Use the Edit tool to modify specific sections. Always read the note first.

### Daily notes

Obsidian daily notes are typically at `Daily/YYYY-MM-DD.md` or `Daily Notes/YYYY-MM-DD.md`. Check the vault structure to confirm.

```bash
# Create or append to today's daily note
TODAY=$(date +%Y-%m-%d)
DAILY="/workspace/extra/vaults/MyVault/Daily/${TODAY}.md"
mkdir -p "$(dirname "$DAILY")"
```

### List recent notes

```bash
find /workspace/extra/vaults/MyVault -name "*.md" -not -path '*/.obsidian/*' \
  -printf "%T@ %p\n" | sort -rn | head -10 | awk '{print $2}'
```

## Tips

- Never modify files inside `.obsidian/` — that's Obsidian's configuration
- Use `.md` extension for all notes
- Wikilinks (`[[Note Name]]`) are plain text — no special handling needed
- Tags in frontmatter use the `tags:` key (array or space-separated)
- If the user doesn't specify a vault and there's only one, use it automatically
- If there are multiple vaults, ask which one unless context makes it clear
