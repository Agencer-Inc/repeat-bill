# repeat-bill

An open benchmark for one question: **what does an agent's bill look like when it does the same kind of tool
work again, asked in new words, with quality held?**

Public agent benchmarks measure quality over one pass of distinct tasks. None of them measures the bill on
repeated tool work, which is what most production agents spend their days doing: the same refund, the same
address change, the same file filing, asked a little differently each time. repeat-bill runs the same twenty
jobs four times, each time in new words and with new data, and records what every step cost and which model
answered it.

## The three domains

Each domain is a desk with 8 to 10 tools over a deterministic store held in the process, built fresh for every
task from that task's own data. Every tool is a pure function of the store and its arguments. Every tool that
acts appends to an ordered list of effects, and the checker reads the end state and that list: a job passes
only when the asked-for change happened and nothing else did.

### support-ops: a shop's support desk

| Tool | Acts | What it does |
| --- | --- | --- |
| `get_ticket` | | Read a ticket: customer, order, subject, body, status, notes, replies. |
| `find_customer` | | Find customers by exact email or by part of a name, with their addresses. |
| `get_order` | | Read an order: items, prices, total, status, tracking number, amount refunded. |
| `list_orders` | | A customer's orders, newest first. |
| `refund_order` | yes | Refund an amount on an order, up to what is left to refund. |
| `update_address` | yes | Replace a customer's address. |
| `add_note` | yes | Add an internal note to a ticket. |
| `close_ticket` | yes | Close a ticket. |
| `escalate_ticket` | yes | Hand a ticket to the billing, shipping or technical team. |
| `send_reply` | yes | Reply to the customer on a ticket. |

The twenty jobs: refund an order in full; refund one item; refund a customer's latest order found by email;
update an address given in the ask; add a note and close; escalate to a named team; read a ticket and escalate
to the team its problem belongs to; reply with a tracking number; say an order's total; say a customer's
latest order and its status; say a customer's postcode; refund and tell the customer the amount; refund the
order a ticket names and close it; take a new address out of a ticket and close it; a goodwill partial refund;
escalate with a note; reply with the amount refunded so far; list an order's items; refund an order's
cheapest item; close two tickets.

Every store holds the target records and look-alikes: a second customer with the same surname, an order id one
digit away from the target's, other open tickets. A guess fails.

### files-ops: a team's document desk

| Tool | Acts | What it does |
| --- | --- | --- |
| `list_folder` | | The folders and files directly inside a folder. |
| `read_file` | | A file's text, tags, fields and who it is shared with. |
| `search_files` | | Files whose name or text contains a piece of text. |
| `create_folder` | yes | Make a folder inside one that exists. |
| `move_file` | yes | Move a file into another folder. |
| `rename_file` | yes | Give a file a new name in the same folder. |
| `tag_file` | yes | Add a tag to a file. |
| `set_field` | yes | Set a named field on a file. |
| `share_file` | yes | Share a file with an email address as a viewer or an editor. |

The twenty jobs: move a file; rename a file; tag a file; find a file by its text and tag it; find a file by
its text and move it; make a folder and move a file into it; share read-only; share for editing with a person
whose email is in the team's contacts file; set the owner field from what the file says; set the client field
from what the file says; say the budget a file states; count the files in a folder; give the path of the file
that mentions something; tag every file in a folder; rename and tag; move and share; move every file whose
status field is done into the archive; set two fields; share with two people; say who a file is shared with.

Look-alikes here are files whose names share a word with the target, files that mention a nearly identical
phrase, and a second person in the contacts file with the target's surname.

### long-jobs: a company's purchasing desk

A desk whose every job is a long chain of tool calls and then one reply, which is what a production agent does
all day. **Every job takes 8 to 15 tool calls in its shortest correct solution**, and later calls use values
earlier calls returned: the order id a create call returned, the sku and vendor a search returned, the email or
the line a read returned. Its step cap is 40, not 25: the longest job is 15 tool calls and a reply.

| Tool | Acts | What it does |
| --- | --- | --- |
| `get_request` | | A purchase request: who asked for it, and its lines, each an item name and a qty. |
| `find_items` | | Catalog items whose name holds every word of the text: sku, name, vendor, unit price. |
| `get_vendor` | | A vendor's name, email and status, active or on hold. |
| `list_orders` | | A vendor's orders, newest first: id, status, date placed. No lines, no totals. |
| `get_order` | | An order: vendor, request, status, lines with qty, price and qty received, total, note. |
| `create_order` | yes | Open a draft order with a vendor for a request. Returns the new order id. |
| `add_line` | yes | Add an item the order's vendor sells to a draft order. |
| `submit_order` | yes | Send a draft order with at least one line to its vendor. |
| `receive_line` | yes | Receive units of one line of a submitted order, up to what is outstanding. |
| `send_email` | yes | Email one address. |

No tool does two records' work, which is what keeps a job long: a search finds one request line's item (no word
is in two item names), a read returns one record or a list of ids, and every acting tool changes one line or
one record. A test walks every job's reference solution on two seeds over all four days and checks that it
takes 8 to 15 calls, that its checker passes it and fails it once a decoy call is added, and that every id,
address and search it passes came from the ask or from an earlier call's result. The test counts the reference
solution; that no shorter one exists rests on the tools above.

| Job | Tool calls | What it asks |
| --- | --- | --- |
| `raise-split` | 13 | Raise a request whose items come from two vendors: an order per vendor, filled and submitted. |
| `raise-and-tell` | 10 | Raise a request on one order, submit it, and email the requester its number. |
| `draft-and-total` | 9 | Put a request on a draft order, leave it a draft, and email the requester its total. |
| `raise-tell-vendors` | 15 | Raise a request across two vendors, submit both orders, and email each vendor its order number. |
| `fill-draft` | 9 | Fill the empty draft a request's vendor already has with the request's lines, and submit it. |
| `receive-and-tell` | 8 | Receive an order that came in complete, and email the requester its number. |
| `receive-note-chase` | 8 | Receive what an order's dock note says came in, and email the vendor the items still owed. |
| `receive-vendor-delivery` | 10 | Receive everything outstanding on every order submitted to a vendor. |
| `reorder-same` | 10 | Place an order again, line for line, and email the requester the new order number. |
| `reorder-short` | 8 | Put what is outstanding on an order on a new order, and email the vendor its number. |
| `chase-late` | 13 | Email the requester of every order still waiting on a vendor that it is late, naming the order. |
| `receive-and-reorder` | 11 | Receive what a dock note says came in, reorder the shortfall, and email the requester the new number. |
| `raise-and-receive` | 12 | Raise a request whose goods are already in: one order, submitted and received in full. |
| `raise-skip-held` | 13 | Raise a request without the items whose vendor is on hold, and email the requester what was left out. |
| `raise-under-limit` | 12 | Raise a request without the lines that cost more than a limit, and email the requester what was left out. |
| `complete-draft` | 9 | Add to a draft order the lines of its request it is missing, and submit it. |
| `talk-largest-order` | 8 | Say which order still waiting on a vendor has the largest total. |
| `talk-dearest-item` | 8 | Say which item on a request has the highest unit price, and the price. |
| `talk-who-asked-largest` | 9 | Give the email of the requester behind the largest order still waiting on a vendor. |
| `talk-held-items` | 9 | Name the items on a request whose vendor is on hold. |

Look-alikes here: every store holds a second request one digit from the target's, by someone with the target
requester's surname. A job that searches finds, beside each item its request names, a dearer look-alike from
another vendor whose name adds a size word (Desk Lamp Large). A job that starts from an order has an order one
digit from it; a job that starts from a vendor has a vendor one digit from it, or orders of that vendor already
received or still drafts, and on two questions a received order larger than every one still waiting.

## Talk steps and tool steps

Sixteen of each domain's twenty jobs are acting jobs. Four are questions, and their last step is a reply in
words that must carry the asked fact (a total, a postcode, a count, a path, a list of names). Every task ends
with a reply in words; on an acting job any reply passes, and on a question the checker reads it: the first
value of the asked kind (an amount, a count, a path, an order id and its status, a postcode, an item) must be the
asked one, and every email the reply names must be one the file is shared with. A task that reaches the step cap
without a reply fails, whatever state it left behind.

On `long-jobs` a question asks for an order id, an item and its unit price, an email, or the items on a request
whose vendor is on hold. An item counts named as the catalog names it, without a final s, or with s or es added,
and the held-items answer must name every such item and no other. Where an acting job emails people about their
own order (`raise-and-tell`, `receive-and-tell`, `raise-tell-vendors`, `chase-late`), each email must name that
order and no other; where it emails the items still owed or left off (`receive-note-chase`, `raise-skip-held`,
`raise-under-limit`), the email must name every such item and no other. The asks of the item jobs say so.

## Days are rounds

"Day" is a round label, not a calendar day. All four rounds run back to back in one sitting.

- **Day 1** is the cold round: twenty tasks, one per job.
- **Days 2, 3 and 4** repeat the same twenty jobs, each asked in different words (a different one of at least
  five phrasings per job) and over different data (new customers, orders, tickets, files, people, phrases,
  vendors and requests). With `--words same`, each job keeps its day-1 phrasing and only the data changes: see
  [The same words every round](#the-same-words-every-round).

Instances are generated from `--seed`: the same seed gives the same tasks, byte for byte, on any machine. No
identifying value (an id, a name, an email, a street, a postcode, a tracking number, a file or folder name, a
tag, a phrase) appears in two tasks of the same domain.

## The same words every round

`--words` chooses the words a run asks in. It is a run setting like `--seed`: both arms take the same one.

- **`--words new`**, the default, is the case above: every later day asks each job in a phrasing it has not
  been asked in yet, the way a person typing would ask it a little differently each time.
- **`--words same`** asks each job in its day-1 phrasing on every day, while every identifying value is still
  new each day. It is the case of a customer's own program, which sends the same words every time with new
  data. No two tasks' text is the same under either setting, since the data never repeats.

The default asks every job in the same words, byte for byte, as a run made before the setting existed, so
every published run stays valid as published, and a `run.json` written before it, which has no `words`, is
scored as `new`. A same-words run draws the very data a new-words run of the same domain and seed drew, so its
playbook arm needs a fresh Reactor API key, as every playbook arm does: a key that ran that new-words run has
already seen every value. A same-words run is otherwise run and scored like any other, with the flag on both
arms:

```bash
node cli.ts run --arm plain --domain support-ops --run-id 2026-10-15-s --seed 1 --words same \
  --base-url https://provider.example/v1 --key PROVIDER_KEY \
  --large claude-sonnet-5-5 --out runs/plain-same
node cli.ts run --arm playbook --client library --domain support-ops --run-id 2026-10-15-s --seed 1 --words same \
  --base-url https://reactor-api.example/v1 --key REACTOR_KEY \
  --provider-url https://provider.example/v1 --provider-key PROVIDER_KEY \
  --large claude-sonnet-5-5 --small claude-haiku-5-5 --reply on --out runs/playbook-same
node cli.ts score --in runs/plain-same --in runs/playbook-same --out scored-same
```

`run.json` records `words`, and `tasks.jsonl` records each task's phrasing as `form`, so a same-words run shows
one `form` per job on all four days. `results.json` has no field for the setting, so the scorer names it at
the start of both arms' `notes`, and the table's heading ends `the same words every round`. The scorer
refuses two arms that differ on `words`. `node cli.ts estimate` sizes a new-words run; a same-words run's asks
differ from it by a few tokens a task.

## The arms

| Arm | What answers |
| --- | --- |
| `plain` | The large model, called directly at its provider's OpenAI-shaped endpoint. |
| `playbook` | The Reactor API's playbook door, with a key made with the same large model and a small model: the harness hands the door each whole job and runs the playbook it answers. `--small` declares the small model so each step can be classified and priced. See [The playbook arm](#the-playbook-arm). |

Both arms get the same tasks in the same order from the same seed, and both arms of one run writes the same
`run_id`. The harness sends every request buffered (never streamed), with `parallel_tool_calls: false`, runs each
tool call in the task's own sandbox, and stops at a reply in words or at the domain's step cap: 25 steps, and 40
on long-jobs. Then the task's checker reads the end state and the reply.

Which model answered a step is read from the `model` its response names: the large model, the small model, or
`other`. A name counts as a model when it is that model's id exactly, or that id plus a dated snapshot suffix
(`-20260929` or `-2026-09-29`). Never a bare prefix: `gpt-4.1-mini` is not `gpt-4.1`.

## The playbook arm

The playbook door takes a whole job, the ask and the tool list, and answers a playbook: the job's steps, each a
tool and its blanks, some marked local. The customer's own library runs it on the customer's machine:
`@agencer/reactor`, which the playbook arm runs with `--client library`. The harness also has a bare client of its
own, `harness/playbook-client.ts`, a test stand-in that takes the same steps without the library. For each task
either client:

1. sends the ask and the tools to `/v1/playbooks`, with `x-reactor-run: <run_id>.<task>` as the job id;
2. fills a step itself when every blank of it is marked local and fills by one of two rules: an ask value the
   playbook already put in place, or a string read at its key from the result of an earlier step whose tool has
   been called exactly once in the job. Nothing else is filled on the client, and a local fill costs nothing;
3. sends every other step to `/v1/playbooks/fill`, with the results so far and `allow_model` (true unless
   `--allow-model false`), and acts on the answer: `filled` calls the tool; `needs_model` and `done` hand the
   job to the agent; `stop` stops;
4. calls each tool in the task's own sandbox and adds the call and its result to the transcript, OpenAI-shaped.
   A refused or empty result stops the job, and so does a filled step for a tool the playbook did not name;
5. hands the job to the customer's agent after the last step, a `needs_model` answer or a `done` answer, as the
   library hands a ready run back: the agent calls the chat model with the transcript so far (at the provider
   `--provider-url` names, the library client through `/v1/playbooks/{job_id}/pass` first, see the client seam), makes each tool call the model asks for with the task's tools, and goes on until the model answers
   in words, a call fails, or the step cap is reached (counted with the playbook's steps). A write the door leaves
   to a model (`needs_model`) is made this way, by the model the agent's call reached. With `--reply on`, a job
   whose playbook ran to its end (its last step, or a `done` answer) first asks `/v1/playbooks/{job_id}/reply` for
   its final reply, with the ask and its steps so far: `words` are the job's reply, written by the door's small
   model, and end it; `needs_model` hands it to the agent as above. The agent's calls and a reply in words go in the
   report as steps of their own, the reply last, with its words and no call;
6. sends `/v1/playbooks/report` once: how the job ended (`done`, `stopped` or `abandoned`); the job's `ask`, the
   transcript's `system` message and the `tools`; and each step it called with who filled it, the shape of its
   result (`ok`, `empty` or `failed`), whether it came back ok, the model the door named, the arguments it was
   called with (`call`) and its `result`. Each field the door bounds is cut to its first bytes and flagged when
   longer: the ask and the system message at 16 KiB, the tools at 64 KiB of JSON, a call at 4 KiB and a result
   at 8 KiB, and the steps at 64. Its `pass_id` is the job id and a nonce drawn once, so a report sent again
   after a 5xx is the same report. Each fill request's results carry each step's `call` beside its `result`.

A job the door could not plan (`needs_model` with no steps) goes to the plain path: the arm runs it as the plain arm
does, under no run, so the large model answers every step and the job has no saving. No report is sent for it,
since no playbook step ran. Its task line says `ended: "plain"`, and the scorer counts such jobs in a note and never
counts a failure among them as a wrong tool call. Both clients hand the job back the same way.

A value goes to a tool as text, as the playbook's blanks carry it. A job that ends with no reply fails its task,
as a chat task that never answers does. Each task line carries a step line saying who filled each step, for
example `1 get_ticket ask ok, 2 refund_order large ok, reply large`, or, for a write the door left to a model,
`1 get_order ask ok, 2 refund_order needs_model, agent large refund_order, reply large`.

**The rounds.** Day 1 is the cold round. Days 2 to 4 are the same jobs over new data: in new words by default,
or in each job's day-1 words with `--words same`. The playbook arm draws them exactly as the other arms do, so a
playbook run pairs with a plain run of the same seed and words, and only with one. Between days it waits
`--settle-seconds` (65 by default), so the day before is learned.

**The client seam.** `--client` picks the client by name from `CLIENTS` in `harness/run.ts`: `bare`, the harness's
own stand-in, and `library`, the customer's own (`@agencer/reactor`, imported by path from
`harness/library-client.ts`), each a function of the same shape that returns the same trace; the arm writes its
records from that trace whichever client ran.

**The library client runs the model on the customer's provider.** The door calls no provider: every prompt it needs
run comes back as a `run_model` answer, which the library runs and posts to `/v1/playbooks/{job_id}/answer`. So
`--client library` needs `--provider-url URL` (the provider's OpenAI-shaped base URL) and `--provider-key ENVNAME`
(the name of the environment variable that holds its key; as `--key`, never the key itself). The runner is the
library's `createOpenAIRunner` on `--small` and `--large`; the door sees only a fingerprint of the provider key,
and the key is written to no file. The agent's own chat calls go to `/v1/playbooks/{job_id}/pass` first, with the
transcript and the tools: `served` is the agent's reply, written by the door; `needs_model` hands the call to the
agent's own chat, which goes to the provider at `--provider-url`.

Lines of `steps.jsonl` on this client, by `route`:

- `playbooks/answer`: a door line for each round the runner ran. Its `served_by` is `small` or `large`, the model
  the runner used, and its cost is the round's usage priced at that model (`usage_reported` is false when the
  provider gave no count).
- `playbooks/pass`: a door line for the pass call. `said` is `served`, `needs_model` or `run_model`. A `served` line
  has `served_by: small` when the door's small model wrote the answer, null otherwise (a result the door already
  had); the agent's step it served is a tool or talk line on the same route, costed $0 since its rounds are the
  `playbooks/answer` lines. A `needs_model` line has no `served_by`; the agent's own chat call follows, a tool or
  talk line on the same route, priced at the model that answered.
- the scorer counts a `playbooks/pass` tool step where it counts a plain-path chat step (`chat/completions`, a
  job the door could not plan, which the library client also sends to the provider).

**The door must have the playbook on.** Start it with `REACTOR_PLAYBOOK_DOOR=on`. Before anything is written,
the arm sends one empty body to `/v1/playbooks`, retried after a 429 or a 5xx as every request is; a door with
the playbook off answers 404, and the arm refuses in one sentence naming the variable. That probe makes no job and
teaches the door nothing, so it goes before the key is filed in the ledger; the key is filed before the first job.

**What it costs.** What the door's answers name as spent (the `x-reactor-spent` header when an answer carries
one, else the answer's own `spent` list, never both), and what each reply call reports, each call priced at
the model it names. A step filled with no model costs nothing. The playbook arm runs on a Reactor key, so it keeps
a key ledger: see [Run it](#run-it).

Try it against the fake door the tests use, which plays every job from its reference solution:

```bash
cd bench
node test/fake-playbook-door.ts --domain support-ops --seed 1 --days 1 \
  --large claude-sonnet-5-5 --small claude-haiku-5-5 &   # prints http://127.0.0.1:<port>/v1
export FAKE_DOOR_KEY=not-a-real-key
node cli.ts run --arm plain --domain support-ops --run-id try-1 --seed 1 --days 1 \
  --base-url http://127.0.0.1:<port>/v1 --key FAKE_DOOR_KEY --large claude-sonnet-5-5 --out runs/try-plain
node cli.ts run --arm playbook --domain support-ops --run-id try-1 --seed 1 --days 1 \
  --base-url http://127.0.0.1:<port>/v1 --key FAKE_DOOR_KEY --large claude-sonnet-5-5 --small claude-haiku-5-5 \
  --ledger runs/try-keys.json --out runs/try-playbook
node cli.ts score --in runs/try-plain --in runs/try-playbook --out runs/try-scored
kill %1
```

The fake door's numbers are its own: it answers with made-up usage and fills every step it is asked to. Against a
real door, run it as [Run it](#run-it) shows, with a fresh key and `--base-url` pointing at that door.

## Run it

Node 22.18 or later. The harness has no runtime dependencies; `npm ci` is only for its tests.

```bash
cd bench
node cli.ts estimate                                   # 1. what a run will cost, from prices.json
# 2. add a line to prices.json for every model you run, with its source and its date
export PROVIDER_KEY=...                                # 3. the large model provider's key
export REACTOR_KEY=...                                 # 4. a fresh Reactor API key, made with the large and small models
node cli.ts run --arm plain --domain support-ops --run-id 2026-10-14-a --seed 1 \
  --base-url https://provider.example/v1 --key PROVIDER_KEY \
  --large claude-sonnet-5-5 --out runs/plain           # 5. the plain arm
node cli.ts run --arm playbook --client library --domain support-ops --run-id 2026-10-14-a --seed 1 \
  --base-url https://reactor-api.example/v1 --key REACTOR_KEY \
  --provider-url https://provider.example/v1 --provider-key PROVIDER_KEY \
  --large claude-sonnet-5-5 --small claude-haiku-5-5 --reply on --out runs/playbook   # 6. the playbook arm, same run id and seed
node cli.ts score --in runs/plain --in runs/playbook --out scored        # 7. results.json for each arm, and the table
cat scored/table.md                                    # 8. read it
npm ci && npm test                                     # 9. the harness's own tests, against a fake endpoint
npm run typecheck                                      # 10. and its types
```

`--base-url` is the endpoint's base, ending before `/chat/completions`. `--key` takes the **name** of the
environment variable that holds the key, never the key: the harness reads it once, sends it as a bearer token,
and never prints or writes it. One `run_id` goes to both arms; use a new one, and a new `--out`, for every run.
Run another domain with `--domain files-ops` or `--domain long-jobs`. Add `--words same` to both arms to ask
every job in its day-1 phrasing: see [The same words every round](#the-same-words-every-round). Run from a git
clone: `harness_commit` is read from git, and a run outside one records `unknown`, which the publication kit
refuses.

The playbook arm keeps a key ledger, `~/.repeat-bill/keys.json` unless `--ledger FILE` names another: for each
base URL, a one-way fingerprint of every Reactor key it has run (the first 12 hex characters of the key's
sha256, never the key) and the run that used the key there before any other. The file is written mode 0600.
Before its first request, a playbook arm whose key the ledger has seen at that base URL prints `the Reactor key
was used by run <id> before this run: day 1 is not cold`, records `key_seen_before: true` and that run's id in
`run.json`, and its notes say so. Add `--fresh-key-required` to the playbook arm to refuse to start on such a
key instead, naming the earlier run: a run meant for publishing should. The ledger sees keys, not accounts:
what is learned is kept per account, so a run meant for publishing uses a fresh key on an account that has
never run this benchmark (see [Known limits](#known-limits)).

A run with real models costs money: see [What a run costs](#what-a-run-costs).

## Reading the table

`node cli.ts score` writes one `results.json` per arm, at `<out>/<run_id>-<domain>/<arm>/results.json`, and
`<out>/table.md` (or `--table FILE`). Each run's section is headed `## <domain>, run <run_id>`, with
`, the same words every round` after it for a run asked with `--words same`. The table has a row per day and
per arm:

| Column | Meaning |
| --- | --- |
| Pass rate | Tasks passed by their checker, of the tasks asked that day. This is the quality that has to hold. |
| Tool steps | Steps whose answer was a tool call. |
| Tool steps the small model answered | `small_model_tool_steps / tool_steps`. 0 on the plain arm. |
| $ per solved task | `cost_per_solved_usd`: what the day cost, divided by the tasks passed. |
| Wrong tool calls | On the playbook arm, the tasks it failed where the plain arm passed the same task. |
| Saving vs plain | Days 2 to 4: `1 - playbook cost_per_solved_usd / plain cost_per_solved_usd`. |

Under it, the saving over days 2 to 4 together, from the summed cost and the summed passes of those days, for
the playbook arm. Wrong tool calls have their own column and are never folded into the saving: a cheaper
day with more failures shows both numbers. A run with a playbook arm then lists each task's step line, under
`### Who filled each step on the playbook arm`.

After those, `table.md` carries one more section per run, headed `## <domain>, run <run_id>: tool steps by the
model that answered, per job`. It has a row per day, per job and per arm, and a row per day and arm for all jobs
together. It is counted from `steps.jsonl` and `tasks.jsonl`, so it is in `table.md` only and never in
`results.json`:

| Column | Meaning |
| --- | --- |
| Job | The job, by the `template` its records carry, or `all jobs`. |
| Pass rate | That job's tasks passed by their checker, of those asked that day. |
| Tool steps | Steps whose answer was a tool call. An `error` step is not one. |
| Large model, Small model, Neither | Tool steps by `served_by`: the model the response named, or neither, which is priced as the large model. |
| Wrong tool calls | On the playbook arm, that job's tasks it failed where the plain arm passed the same task. `n/a` on the plain arm, and on a playbook arm scored without it. |
| Cost | Every step of that job's tasks that day, at the run's prices. |

A playbook arm has a section of its own instead, headed `## <domain>, run <run_id>: who filled each tool step on
the playbook arm, per job`, with the same rows and its tool steps counted by who filled them: the ask, an earlier
result, the door's small model, its large model, or nobody named.
Two more sections follow it: the final reply per day, who wrote it and the door's refusals by kind, beside the cost
with every tool step free; and the rerun's measures per day (2026-10-30): the steps a job the small model closed
skipped, the replies the claim check refused, the wrong calls by cause as the records tell it, and the door's round
trip on a fill and a report, with each wrong call listed under it.

## results.json

One file per arm of one run. Every field name is a contract: the publication kit renders from it and validates
it.

| Field | Type | Meaning |
| --- | --- | --- |
| `benchmark` | `"repeat-bill"` | |
| `version` | `"0.1"` | |
| `arm` | `"plain"` or `"playbook"` | `"reactor"` is accepted in results written by an earlier arm the harness no longer documents. |
| `large_model` | string | The large model's id. The same on both arms. |
| `small_model` | string or null | The playbook arm's small model; `null` on the plain arm. |
| `domain` | string | `support-ops`, `files-ops` or `long-jobs`. The same on both arms. |
| `run_id` | string | The same on both arms of one run. |
| `harness_commit` | string | The git commit of bench/ that ran. The same on both arms. |
| `prices` | object | `{ <model>: { in_per_mtok, out_per_mtok } }`, the prices every step was costed at. |
| `days` | array | One entry per day, in order. |
| `step_lines` | array | The playbook arm only; the plain arm carries none. `{ day, job, line }` per task: its step line. |
| `notes` | string | What the numbers cannot show by themselves: the gaps below, counted for this run. A run asked with `--words same` says so first. A playbook arm says what the key ledger saw of its key. |

Each entry of `days`:

| Field | Type | Meaning |
| --- | --- | --- |
| `day` | integer | 1 to 4. |
| `tasks` | integer | Tasks asked that day: 20. The same on both arms. |
| `passed` | integer | Tasks the checker passed. |
| `tool_steps` | integer | Steps whose answer was a tool call. |
| `talk_steps` | integer | Steps whose answer was a reply in words. |
| `small_model_tool_steps` | integer | Tool steps the small model answered. 0 on the plain arm. |
| `no_model_tool_steps` | integer | The playbook arm only: tool steps filled with no model, by the client or by the door from the ask or a result. |
| `wrong_tool_calls` | integer or null | Playbook tasks failed where the plain arm passed the same task. `null` means not measured: always on the plain arm, which is the reference, and on a playbook arm scored without its plain arm. |
| `failed_calls_on_passed` | integer | Tool calls the tool itself refused (the bench tools answer `{ "error": "..." }`) on tasks that still passed: a wrong turn the task recovered from. Counted from each step's `tool_failures` (2026-10-23); a step line written before carries none and counts 0. Never among the wrong tool calls, whose rule is unchanged. |
| `cost_usd` | number | The day's spend at `prices`, to six decimals. |
| `cost_per_solved_usd` | number or null | `cost_usd / passed`; `null` exactly when `passed` is 0. |
| `median_task_seconds` | number | The median wall-clock time of the day's tasks. |
| `step_ms` | object | Not required; only on runs whose step lines carry their time (since 2026-11-09). A tool step's wall time in ms, from the step before it in the job to its own end, keyed by who filled it (`plain`, `no_model`, `small`, `large` at the door, `handed_back` to the agent), each `{ steps, median_ms, p90_ms }`. The table sets each beside the plain arm's step on the same day. |

## The step records

`node cli.ts run` writes three files to `--out`, and `node cli.ts score` reads only these:

- `run.json`: the run's settings (the seed, `words`, the step cap and the request timeout among them), the
  prices it used, the harness commit (with `-dirty` when a tracked file of bench/ other than `prices.json` had
  uncommitted changes), and when it started and finished. On the playbook arm, `key_seen_before` says whether
  the key ledger had seen its key at that base URL, and `key_earlier_run_id` names the run that used it there
  when it had; both are `null` on the plain arm, and on a playbook arm run with no ledger. The playbook arm also
  records `client` and `allow_model`.
- `steps.jsonl`: one line per model response, with the day, the task, the step number, `kind` (`tool`, `talk`
  or `error`), the tool named, `served_by` (`large`, `small` or `other`, and `null` on an `error` step), the
  response's model name, prompt and completion tokens, whether usage was reported, latency, retries and cost.
  On the playbook arm a line is one thing the client did: a `door` line per answer of the playbook routes (its
  `route`, what a fill answer `said`, its spend in `overhead_usd`, and `usage_reported`, whether the answer named a
  spend whose every call the price book prices; on a `filled` answer, `served_by` is the door's model it names,
  `other` when it names nobody, and `null` when it names the ask or a result), a `tool` line per call (`filled_by`,
  and `served_by` read the same way, or `null` when no model filled it), and a `talk` line per reply call.
- `tasks.jsonl`: one line per task, with the phrasing it was asked in (`form`), whether it passed and why, its
  steps, whether it hit the step cap, and its wall-clock seconds. On the playbook arm, its `steps` count every line
  the task wrote (door answers, calls and the reply call), and it adds its `step_line`, how its job `ended`, and
  whether the door took its report (`reported`).

A 429, a 5xx, a network error or a timeout (`--timeout-seconds`, 120 by default) is retried twice, after 1 s
and then 4 s, and the retries are counted on the step. Any other refusal, or a 2xx whose first choice carries
no message, ends the task as failed, with an `error` step that carries the status or that reason only.

An endpoint that answers with several tool calls in one response despite `parallel_tool_calls: false` has every
one of them run, in order; the response counts as one tool step, and its `tool_calls` field says how many.

`node cli.ts score` pairs the arms of a run by `run_id` and domain, the playbook arm with the plain arm; arms on different domains are scored apart. It refuses a pair that differs on the large model, the
harness commit, the days, the seed, `words`, the
step cap or the request timeout, or that was costed at different prices for the large model: a saving read
across two price books would measure the price change, not the arms. It also refuses a run in which
a step answered as the large model, or by neither model, came back without usage: that step's cost is unknown.
On the playbook arm that holds for a fill the door says its large model made, or one naming nobody, whose answer
named no spend, or named a call at a model the price book has no line for; a fill its small model made that way
costs $0 and is counted in the notes.

## What a run costs

A run with real models costs money. This is an **estimate**, not a measurement: the reference solutions' own
conversations, measured at 4 characters a token, 20 tasks a day for 4 days, at the list prices in
`prices.json`. A real model thinks, retries and writes longer replies, so expect more. The last column, headed
`Reactor arm`, is the playbook arm: it reads somewhere between its floor (every tool step after day 1 filled
at no visible cost) and the plain figure (none filled that way), plus the small model's own spend, which this
does not estimate. `node cli.ts estimate` prints this table from the current `prices.json`:

| Large model | Domain | Steps | Plain arm | Reactor arm |
| --- | --- | --- | --- | --- |
| claude-fable-5-1 | support-ops | 248 | $3.23 | $1.57 to $3.23 |
| claude-fable-5-1 | files-ops | 231 | $2.77 | $1.36 to $2.77 |
| claude-fable-5-1 | long-jobs | 896 | $17.43 | $5.74 to $17.43 |
| claude-opus-5-5 | support-ops | 248 | $1.29 | $0.63 to $1.29 |
| claude-opus-5-5 | files-ops | 231 | $1.11 | $0.54 to $1.11 |
| claude-opus-5-5 | long-jobs | 896 | $6.97 | $2.30 to $6.97 |
| claude-sonnet-5-5 | support-ops | 248 | $0.65 | $0.31 to $0.65 |
| claude-sonnet-5-5 | files-ops | 231 | $0.55 | $0.27 to $0.55 |
| claude-sonnet-5-5 | long-jobs | 896 | $3.49 | $1.15 to $3.49 |
| claude-haiku-5-5 | support-ops | 248 | $0.03 | $0.02 to $0.03 |
| claude-haiku-5-5 | files-ops | 231 | $0.03 | $0.01 to $0.03 |
| claude-haiku-5-5 | long-jobs | 896 | $0.17 | $0.06 to $0.17 |

## Prices

`prices.json` holds US dollars per million tokens, per model, each line with its source and the date it was
read. **Add a price line, with its source and date, for every model you run**: the harness refuses a model it
has no price for. The `text-embedding-3-small` line is listed for reference, was not read live, and no step of a
run is priced at it.

## Known limits

- **The playbook arm's cost is a floor, so its saving is a ceiling.** It counts what the door's answers name as
  spent and what its reply calls report. The calls the door makes under a step are named on its answer, in
  `x-reactor-spent` or its `spent` list, and priced into that line's `overhead_usd`, so a day's cost includes
  them; a call at a model `prices.json` has no line for counts $0 and is counted in `overhead_unpriced`. A step
  filled with no model costs $0. Each step line also counts the tool calls the tool itself refused as
  `tool_failures` (2026-10-23), and a refused step's line carries the call as it was sent and the tool's words as
  `refused` (2026-10-30). Spend the door's answers do not name is not counted. The notes of every playbook
  `results.json` say so, and count the steps that reported no usage.
- **One run per task.** The harness sends `x-reactor-run: <run_id>.<task>` as each job's id, because
  a run is never answered from what it taught itself. Sending one run id for a whole day would make every task
  one run, and days 2 to 4 would be answered by the large model throughout.
- **The settle wait.** A finished task is learned once it has been quiet for 60 seconds and a later request
  arrives, so the playbook arm waits `--settle-seconds` (65 by default) between days. The first task of a day can
  still be asked before the day before is learned; that counts against the playbook arm.
- **A task the small model answered steps of is learned only as far as those steps were verified.** Each served
  step is recorded with the check it passed, and a task teaches up to its first served step whose record does not
  say verified. A task the large model answered in full is learned as before.
- **Day 1 is cold only on a fresh key on a fresh account.** What is learned is kept per customer account, not
  per key, so a Reactor key that has run this benchmark before, or a new key made on an account that has, starts
  day 1 warm. Use one fresh Reactor API key, on an account that has never run this benchmark, for every
  playbook-arm run. The key ledger catches a key this machine ran before at the same base URL: `run.json` records
  `key_seen_before`, the notes say day 1 is not cold, and `--fresh-key-required` refuses to start. A key is
  filed once the run is set up, before its first request, so a run that stopped after that, even on an error
  from the endpoint, counts as having used it. The ledger sees keys, not accounts: it cannot see a new key on an
  account that ran this benchmark before, nor a key used on another machine, through another base URL, before
  the ledger existed or after its file was removed, and the notes of a key it had not seen say so. Two playbook
  arms filing keys in the same instant on one machine can each miss the other, and one arm's entry can be lost
  for good.
- **The small model is fixed by the key,** when the key is made. `--small` declares it; a response that names
  neither model is classified `other`, priced as the large model, and counted in the notes.
- **The Reactor API's own lookups** run on the vendor's account, not the customer's, and are not counted.
- **No prompt-prefix discount** is applied on either arm: every input token is priced at the list rate. That
  overstates the large model's steps on both arms, and leans the saving up.
- **Buffered, one tool call a turn.** An endpoint that refuses `parallel_tool_calls` fails every task, visibly.
- **A question is read by its first value.** A reply that names the look-alike first, as context, fails; the same
  rule scores both arms, so the saving stays fair.
- **The domains are synthetic.** They are built so their jobs repeat, which is the case this benchmark exists
  for; they say nothing about how often a given business repeats its own work.
- **The playbook arm's client is a stand-in.** The bare client fills only by its two rules and passes every value
  as text; the customer's library may fill more, and pass numbers as numbers. A refused or empty result ends a
  job before its reply, so on this arm a task with a failed call never passes, and its count of failed calls on
  passed tasks is always 0.
