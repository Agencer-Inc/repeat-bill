# Submitting a result

A result is one run, both arms, added by one pull request. `bench/METHOD.md` says what a valid run
is; this page says how to hand one in.

## What to add

One folder, named for the date the run happened, who ran it, and its domain:

```
bench/results/<date>-<org>-<domain>/
  plain/results.json
  playbook/results.json
  COMMANDS.md
  prices.json
```

- `<date>` is the calendar date both arms ran, as `YYYY-MM-DD`. `<org>` is who ran it, lowercase,
  no spaces. `<domain>` is the `domain` field of both files.
- `plain/results.json` and `playbook/results.json` are the two arms, exactly as the harness wrote
  them (`node cli.ts score` writes them at `<run_id>-<domain>/<arm>/results.json`), sharing one `run_id`. No other
  run of the same domain under `bench/results/` may use that `run_id`: `<date>-<org>`, as the folder's name
  begins, is a good one.
- `COMMANDS.md` holds the exact command lines that produced both files, the seed and the harness
  commit among them, so anyone can run them again. `bench/README.md` says how to run both arms.
- `prices.json` is the price list the run used, with a source and a date on every line.

## Check it before you open the pull request

```
node bench/publish/render.mjs --in bench/results --out /tmp/repeat-bill/index.html
```

It needs Node 24 and nothing installed. Exit 0 means every file passed the schema and the rules
`render.mjs` checks; open the page and read your run. Anything else names the file and the first
field that failed, or the run whose two arms do not pair.

## What happens to it

1. **CI validates it.** The bench workflow runs on every pull request that touches `bench/`. It runs
   the renderer's tests, then renders every `bench/results/**/results.json`, which checks each one
   against `bench/publish/schema.json` and the rules of `bench/METHOD.md` that the renderer checks.
   A red check names the file and the field, or the run.
2. **A maintainer reviews it** against what the renderer does not check: the seed, which tasks were
   asked, the price sources and whether both files carry the same prices, the date, that the plain
   arm's `wrong_tool_calls` is `null`, that nothing was edited by hand, and that the pull request
   changes nothing outside its own folder. CI runs the renderer from the pull request itself, so a change to
   `bench/publish/` would check the submission against rules the submitter wrote.
3. **A maintainer re-renders the page** after the merge and commits it:

   ```
   node bench/publish/render.mjs --in bench/results --out bench/results/index.html
   ```

## Not accepted

- **A result with one arm only.** The saving is a comparison, and one side of it is not a result.
- A `results.json` edited by hand.
- A link, or a `.json` file named anything but `results.json` or `prices.json`. The renderer
  refuses both, rather than skip a result it was never shown.
- A run whose arms differ on the large model, the domain, the harness commit, the days, or the
  number of tasks on any day.
- A run that breaks any rule of a valid run in `bench/METHOD.md`.

## License

A submission is a Contribution under section 5 of the Apache License 2.0 (`bench/LICENSE`), and is
published under that license with the rest of `bench/`.
