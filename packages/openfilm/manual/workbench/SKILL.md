---
name: workbench
description: Read the OpenFilm production board, today's topic recommendations, a video's performance snapshots, or the weekly report through the OpenFilm CLI.
---

# Production workbench

Read data from the OpenFilm installation where Studio runs. The workbench belongs to that installation, so these commands can run outside a film's folder.

- `openfilm workbench list --json` lists project IDs, status, publication details and the latest recorded performance.
- `openfilm workbench topics today --json` reads the saved recommendations and source status for today.
- `openfilm workbench video stats <project-id> --json` reads the saved metric snapshots and T+1, T+3 and T+7 samples. Match the project ID using the list first.
- `openfilm workbench report weekly` returns the Markdown report. Use `--json` for machine-readable output.

Use the recorded capture time when comparing metrics. A missing snapshot means the workbench has no sample for that period. Treat recommendation and attribution text as hypotheses and ground your summary in the recorded data. If today's recommendations are absent, direct the person to Today in Studio to generate them.
