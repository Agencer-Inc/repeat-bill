# The outside test

The bench measures Reactor with its own harness. This folder measures it the way a customer would: a plain agent
of about fifty lines, written with the OpenAI SDK, runs the bench's jobs. Arm A calls the provider directly. Arm B
changes one line, and its client goes through `@agencer/reactor` from npm. The result is the provider's bill, not
anything this folder prints.

| Arm | What runs | Provider key |
| --- | --- | --- |
| A | the agent on the large model, direct | `OPENAI_KEY_A`, its own provider project |
| B | the same agent, `reactor.wrap(new OpenAI(), { key, small })` | `OPENAI_KEY_B`, its own project; `REACTOR_API_KEY` |
| C | the agent on the small model alone | `OPENAI_KEY_C`, its own project |
| F | the agent through OpenRouter's router, held to the same two models | `OPENROUTER_API_KEY` |

One project per arm, so each arm's spend is its own line on the usage page.

## Run it

```sh
cd bench && npm ci && cd outside && npm install
export LARGE_MODEL=gpt-4.1 SMALL_MODEL=gpt-4o-mini
export OPENAI_KEY_A=... OPENAI_KEY_B=... OPENAI_KEY_C=... REACTOR_API_KEY=... OPENROUTER_API_KEY=...
cd .. && node outside/run.mjs --arms A,B,C,F --domains support-ops,files-ops --days 4 --seed 8 --out runs/outside
node outside/summary.mjs runs/outside
```

- **Turns:** the arms take turns job by job, so they meet the same hour of every provider. Each job runs in a fresh
  sandbox.
- **Days:** day 1 is cold. Days 2 to 4 ask the same jobs in new words with new data. When arm B runs, the run waits
  `--settle` seconds (65 by default) between days, so a day is learned before the next one asks it again.
- **Partial runs:** `--limit N` takes the first N jobs of each day, and `--from D` starts at day D.
- **The record:** `jobs.jsonl` gets one line per job and arm, with whether it passed, why, its steps and seconds, and
  the tokens each response reported, its `cached_tokens` included.
- **What `summary.mjs` prints:** per arm and day, the jobs, the passes, the wrong calls (a job the arm failed where
  arm A passed it), the token counts with the share of the prompt in `cached_tokens`, and the median seconds.
- **What is left to you:** read the spend off each project's usage page.

Arm F's model name and plugin are the ones the test was planned with (`typesafe/jev-router`, plugin `jev-router`). Check both
against OpenRouter's router page before a run; `JEV_MODEL` and `JEV_PLUGINS` (JSON) override them.

## Test it without keys

`fake-serve.ts` serves the bench's fake model, which plays each job's reference solution. With `door` it serves the
fake playbook door too. Point the arms at it with `OUTSIDE_PROVIDER_URL` and `REACTOR_BASE_URL`:

```sh
node outside/fake-serve.ts support-ops door      # prints the model's URL, then the door's
OUTSIDE_PROVIDER_URL=<model url> REACTOR_BASE_URL=<door url> OPENAI_KEY_A=x OPENAI_KEY_B=x REACTOR_API_KEY=x \
  LARGE_MODEL=big-model SMALL_MODEL=small-model node outside/run.mjs --arms A,B --days 2 --limit 3 --settle 0
```
