# The repeat-bill benchmark: method

Version 0.1. Everything under `bench/` is under the Apache License 2.0: see `bench/LICENSE`.

## What it measures

An agent that does the same kinds of jobs every day pays its large model for every tool step, every
time, even when the job is one it has done many times before, asked in new words.

The Reactor API sits between an agent and its models. It learns the tool steps of jobs it has seen,
and when a later step is one it has learned, a small model answers it, checked against the
conversation. Every step it cannot answer that way goes to the large model, as it would without the
Reactor API.

This benchmark measures **the bill on repeated tool work asked in new words, with quality held**:
what the same tasks cost per solved task with and without the Reactor API, and whether the pass rate
holds while the cost falls.

It is not a test of one pass over distinct tasks. Public agent benchmarks already measure the
quality of that, and they do not ask the same job again in new words, which is the case this
benchmark is about.

## Days

A **day is a round of tasks, not a calendar day.** All four rounds run back to back, in one sitting.

- **Day 1 is cold.** Nothing of the domain has been learned. Its tasks cover the domain's job types.
- **Days 2, 3 and 4** ask the same job types again, each day in new words and with new data: new
  names, new ids, new amounts. No task's text repeats from an earlier day.

**The words setting.** The above is `--words new`, the default. A run made with `--words same` asks
each job in its day-1 phrasing on every day, with new data each day as above: the case of a
customer's own program, which sends the same words every time with new data. Its task text still
never repeats, since the data does not. Day 1 is the same under both settings.

Both arms get the same tasks, in the same order, generated from the same fixed seed and the same
words setting.

## Domains

Each domain is a desk of tools over a store built fresh for every task, with twenty jobs:

- `support-ops`, a shop's support desk, and `files-ops`, a team's document desk: shorter jobs, a few
  tool calls and then a reply.
- `long-jobs`, a company's purchasing desk: every job takes **8 to 15 tool calls** in its shortest
  correct solution, each later call using values an earlier call returned, and then one reply. It is
  the long chain of tool steps a production agent runs all day. A test counts the calls of every
  job's reference solution and checks that every id it passes came from the ask or an earlier result.

A task stops at a reply or at its domain's step cap: 25 steps, and 40 on `long-jobs`, whose longest
job is 15 tool calls and a reply.

## The arms

| Arm | What the agent calls |
| --- | --- |
| `plain` | The large model, directly. |
| `playbook` | The Reactor API's playbook door, set up with the same large model and a small model, which answers a whole job with its steps. |

Everything else is the same for both arms: the tasks, the tools, the harness commit and the calendar date.
The arms of one run share a `run_id`, and their `results.json` files are published together. A run has a plain
arm and a playbook arm, and the playbook arm is measured against the plain arm.

**The playbook arm** plays the customer's side of the playbook door with a bare client of the harness's own, a
stand-in for the customer's library until that library replaces it. The client sends the door each job, fills a
step itself only when every blank of it is marked local and is an ask value already in place or a string read
from the result of an earlier step whose tool ran exactly once, asks the door for every other step, calls each
tool in the task's own sandbox, and asks for the reply in words in one call to the large model once the steps
are done. A refused or empty result, or an act the playbook did not name, ends the job. It reports how each job
ended to the door. Its rounds are the plain arm's rounds: day 1 cold, then new data each day in new words or,
with `--words same`, in each job's day-1 words.

## What a results.json holds

One file per arm. `bench/publish/schema.json` is the exact shape; every field is required but the playbook
arm's own two, `step_lines` and each day's `no_model_tool_steps`, which the plain arm does not carry, and the top level
allows no other field.

| Field | Meaning |
| --- | --- |
| `benchmark`, `version` | `"repeat-bill"` and `"0.1"`. |
| `arm` | `"plain"` or `"playbook"`. The schema also accepts `"reactor"`, for results written by an earlier arm. |
| `large_model` | The large model's id. The same on both arms. |
| `small_model` | The small model's id on the playbook arm; `null` on the plain arm, which has none. |
| `domain` | The domain the tasks come from. The same on both arms. |
| `run_id` | The run both arms belong to. No other run under `bench/results/` uses it. |
| `harness_commit` | The git commit of the harness that ran, 7 to 40 hex characters. |
| `prices` | For each model id: `in_per_mtok` and `out_per_mtok`, US dollars per million tokens in and out. |
| `days` | One entry per round, day 1 to day N, each once. Fields below. |
| `step_lines` | The playbook arm only: one `{ day, job, line }` per task, its line saying who filled each step and how its job ended. |
| `notes` | Free text. May be empty. A run made with `--words same` says so first. A playbook arm says what the harness's key ledger saw of its key. |

Each entry of `days`:

| Field | Meaning |
| --- | --- |
| `day` | The round's number, from 1. |
| `tasks` | Tasks asked that day. The same on both arms. |
| `passed` | Tasks the arm solved, by the task's own check. |
| `tool_steps` | Steps whose answer was a tool call. |
| `talk_steps` | Steps whose answer was a reply to the user. |
| `small_model_tool_steps` | Tool steps the small model answered. 0 on the plain arm. |
| `no_model_tool_steps` | The playbook arm only: tool steps filled with no model, from the ask or an earlier result. |
| `wrong_tool_calls` | See below. `null` on the plain arm, and on the playbook arm when not measured. |
| `cost_usd` | What the arm spent on models that day, at the file's `prices`. |
| `cost_per_solved_usd` | `cost_usd / passed`; `null` exactly when `passed` is 0. |
| `median_task_seconds` | The median wall-clock time of the day's tasks. |
| `step_ms` | Not required: a tool step's wall time in ms by who filled it, from the step before it to its own end, on runs whose lines carry their time (since 2026-11-09). |

## Metrics and their formulas

Per arm and per day:

- **Pass rate** = `passed / tasks`. This is the quality that has to hold: compare it day by day,
  arm against arm.
- **Tool steps not answered by the large model** = `small_model_tool_steps / tool_steps`, and on the
  playbook arm `(small_model_tool_steps + no_model_tool_steps) / tool_steps`. 0 on the plain arm; n/a
  when `tool_steps` is 0.
- **Cost per solved task** = `cost_per_solved_usd = cost_usd / passed`, and `null` when `passed`
  is 0, since nothing was solved to divide by.
- **Saving before Reactor's share-of-savings charge**, on days 2 to 4 =
  `1 - playbook cost_per_solved_usd / plain cost_per_solved_usd`, for the same day of the same run.
  Positive means the playbook arm paid less per solved task. It reads n/a when either side is `null`,
  or when the plain arm's is 0. Day 1 shows none: it is cold, and it is the round the learning is
  paid for. It is the saving on the model bill alone: Reactor's own charge is not taken out of it.
- **Wrong tool calls** = on the playbook arm, the number of the day's tasks the playbook arm failed
  where the plain arm passed the same task. The plain arm is the reference and has no count of its
  own: it writes `null` every day, and the page reads n/a, not 0. On the playbook arm, `null` means
  it was not measured, and the page reads n/a.

## What makes a run valid

1. **A fixed seed and words setting**, written in the command lines, so the same tasks can be
   generated again. Both arms share both: `node cli.ts score` refuses a pair that differs on either.
2. **A prices.json with a source and a date on every line**, and the `prices` of both files taken
   from it.
3. **Both arms on the same models**, the same domain and the same tasks, **on the same calendar
   date**. The playbook arm adds only the small model.
4. **No hand edits.** A `results.json` is what the harness wrote, byte for byte.
5. **`harness_commit` recorded**: the commit of the harness that produced both files.
6. **Both arms published together**, under one `run_id`.
7. **A fresh Reactor API key on a fresh account, on the playbook arm**: an account that has never run
   this benchmark, so day 1 is cold. What the Reactor API learns is kept per account, not per key, so
   a new key made on an account that has run this benchmark starts day 1 warm. The harness keeps a key
   ledger on the machine that runs it: for each base URL, a one-way fingerprint of every Reactor key it
   has run, never the key. A playbook arm whose key the ledger had seen says so in its notes (`The
   Reactor key was used by run <id> before this run: day 1 is not cold.`), and `--fresh-key-required`
   refuses to start one. The ledger sees keys, not accounts. A published run uses a fresh key on a
   fresh account, and its playbook arm's notes show what the ledger saw.

`bench/publish/render.mjs` checks these, and refuses the file or the run by name:

- a file that breaks the schema, naming its first failing field;
- a link, or a `.json` file not named `results.json` or `prices.json`, anywhere under the results
  folder;
- a plain arm whose `small_model` is not `null` or whose `small_model_tool_steps` is not 0 on
  some day, or a playbook arm with no `small_model`;
- `step_lines` or a day's `no_model_tool_steps` on an arm other than the playbook arm;
- `days` whose numbers are not 1 to N, once each;
- `passed` above `tasks`, `small_model_tool_steps` above `tool_steps`, or the two not-large counts
  together above `tool_steps`;
- `cost_per_solved_usd` that is not `cost_usd / passed` to within $0.000001, or not `null` when
  `passed` is 0;
- a `run_id` without exactly one plain arm and one playbook arm (an earlier result's `reactor` arm
  counts in the playbook arm's place, or beside it, and two such arms must agree on `small_model`);
- an arm that differs from the plain arm on `large_model`, `domain`, `harness_commit`, the number
  of days, or the number of tasks on any day;
- two arms whose notes disagree on whether the run was asked in the same words: one leads with the
  sentence the scorer writes for `--words same` and the other does not. The page labels each run,
  above its chart and table, same words or new words by that sentence.

It does not check the seed, the words setting beyond that sentence, whether the Reactor key or its
account was fresh (the playbook arm's notes say what the key ledger saw), which tasks were asked, the price sources or
whether both files carry the same prices, the date, that the plain arm's `wrong_tool_calls` is `null`,
or the absence of hand edits. Those rest on the submission and on the review of its pull request.

## Known limits

- **The domains are synthetic.** They are built so their jobs repeat, which is the case this
  benchmark exists for. They say nothing about how often a given business repeats its own work.
- **Vendor prices change.** A result is priced at the prices it records, each with its source and
  date. Compare runs on their own prices, not on today's.
- **A reply to the user is the large model's unless `--reply on` asks the door for it.** Without it only
  tool steps can move to the small model, so in a domain where half the steps are replies, at most half
  of all steps can, however well its tool steps are learned. With `--reply on` the door's small model may
  write the final reply of a job whose playbook ran to its end, when every value in it stands in the job;
  any other reply is still the large model's. On `long-jobs` the reply is one step of 9 to 16 in every
  reference solution.
- **The playbook arm's cost is a floor, so its saving is a ceiling.** It counts what the door's
  answers name as spent and what its reply calls report; spend the door's answers do not name is not
  counted, and a step filled with no model costs $0.
- **The saving is before Reactor's share-of-savings charge.** That charge is not taken out of it,
  and this benchmark does not compute the figure net of it.
- **The playbook arm adds latency**: the door's round trip on each fill and report. It is reported
  as `median_task_seconds`, per arm and per day, and is not folded into the cost.
- **Four rounds in one sitting** measure what is learned over a short span, not over weeks of work.
- **The playbook arm's client is a stand-in** for the customer's library. It fills only by its two
  rules and passes every value as text. A refused or empty result ends a job before its reply, so a
  task with a failed call never passes on this arm.

## License

`bench/` is under the Apache License 2.0. The full text is `bench/LICENSE`.
