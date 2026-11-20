---
name: demo-deck
description: Build a demo deck of recent Dataform Cost Check work for a mostly non-technical audience, from real sandbox PR comments. Use when the maintainer asks for a demo, a deck, or slides about what was built.
---

# Demo deck

Read the maintainer's memory notes `demo-decks` and `demo-workflow` first: they hold past
deck links, the style bar and the audience. Finish and merge code before starting the deck.

1. **Scope.** List the merged PRs and releases since the last deck (`gh pr list --state merged`).
   Group them into 5–8 stories a non-technical audience cares about.
2. **Real output only.** Use comments the action actually posted. Run the `sandbox-check`
   skill if the sandbox is not on the latest release. Fetch each comment body with
   `gh api repos/<sandbox>/issues/<n>/comments`.
3. **Screenshots.** The repos are private, so headless captures of github.com fail. Render
   each body with `gh api markdown -f mode=gfm -f context=<repo> -F text=@comment.md`, wrap it
   in GitHub's markdown CSS (`github-markdown-css` from cdnjs), and screenshot it with the
   Playwright `chrome-headless-shell` in `~/Library/Caches/ms-playwright`
   (`--screenshot --window-size --force-device-scale-factor=2`). Look at every image before using it.
   Caption them "rendered by GitHub", not as page captures.
4. **Deck.** A new Slides artifact per demo (never update an old demo's deck). Per feature:
   a numbered punchline, the tilted real screenshot, and an honesty sticker:
   "Verified live" (real BigQuery or GitHub run) or "Tested in code" (unit tests only). Add a
   scoreboard of real counts, a "plot twist" slide for anything that surprised us, and an
   honest "what's next" slide. Plain words ("proposed change", not "PR" or "dry run").
   Speaker notes on every slide say what is and is not proven.
5. **Check** the vertical space on dense slides before publishing (824 px inside the margins),
   and give the link with one line on what changed.
