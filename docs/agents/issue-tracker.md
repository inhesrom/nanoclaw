# Issue tracker: Local Markdown

Private feature maps and their issues live under `.scratch/`, which is git-ignored. A task may explicitly choose another tracker; otherwise use the tracker already named by its map or plan.

## Wayfinding layout

- One feature per directory: `.scratch/<feature-slug>/`
- `MAP.md` is the canonical index and contains the destination, frontier, decision pointers, boundaries, and remaining fog.
- Child tickets live in `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.
- Each ticket starts with `Status`, `Label`, `Parent`, `Assignee`, and `Blocked by` fields.
- An open, unassigned ticket whose blockers are closed is frontier work.
- A working session claims one non-research frontier ticket at a time. Independent research tickets may be resolved concurrently.

## Resolving a ticket

1. Assign the ticket before working it.
2. Append the outcome under `## Comments` as a dated resolution comment.
3. Set `Status: closed` without removing the ticket's dependency history.
4. Add one linked, one-line gist under the map's `Decisions so far`.
5. Add newly revealed tickets and dependency links.
6. Remove the corresponding item from `Not yet specified`.

The map is complete only when every child ticket is closed, `Not yet specified` is empty, and the destination acceptance criteria are demonstrably satisfied. Do not stage or commit `.scratch/` artifacts.
