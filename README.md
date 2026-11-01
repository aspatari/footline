# footline

A status line for the Claude Code footer. One row, right of the mode indicator, always in view:

```
 main* +shared  opus 5.5 high  ctx ━╸─── 180k/1M  5h ━━─── 38% 2h  wk ━╸─── 29% 3d5h
```

- **Branch**, with `*` when the working tree has changes. Polled every 10 seconds, so a switch made from another terminal shows up too.
- **Added directories** from `/add-dir` and `permissions.additionalDirectories`, as `+name`. Past three they are counted, and a tight row shows the count alone.
- **Model and effort**, short. Effort comes from your settings, then from what each turn really ran on.
- **Context fill, 5-hour and weekly limits**, green, then yellow past 50%, red past 75%. Each limit shows the time left to its reset: `30m`, `3h`, `3d5h`.

Colours are Claude Code theme keys, so they follow your theme. On a narrow terminal the bars go first, so the row stays on one line for as long as it can.

## Install

At the prompt of a terminal session:

```
/plugin install footline --marketplace aspatari/footline
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install footline --marketplace aspatari/footline
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `aspatari/footline`, then Add plugin.

## Notes

- The branch glyph (U+E0A0) needs a Powerline or Nerd Font.
- The limits need a Claude subscription, and can appear only after the first response of a session.
- Directories given with the `--add-dir` flag are not shown: Claude Code does not tell a mod about them. `/add-dir` works, and those are kept for the current run only.
- It replaces the footer's own dim mode labels with its row and keeps their text in front of it.

## Develop

```
claude plugin validate .
claude plugin test .
```

MIT licensed.
