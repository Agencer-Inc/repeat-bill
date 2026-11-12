# 2026-11-10-agencer, files-ops

Both arms ran on 2026-11-10, seed 8, 4 days, `--words new`, from the same harness. The `harness_commit` both
`results.json` files record, `8ee89f335956b240a14d7ec5d4c51d48b098b456`, is a commit of Agencer's private repository, where `bench/` was developed. The
harness, the tasks, the scorer and `prices.json` in `bench/` here are that commit's, unchanged but for comments, a
name taken out of two sentences of the table's notes, and the import of the client library, which here is `@agencer/reactor` from npm and there was the same library's
source.

The playbook arm started cold: the bench tenant's learned records were deleted first. The large model is Claude
Opus 5.5 and the small one Claude Haiku 5.5, both on Anthropic's API. The playbook arm went through Reactor's staging
deployment (`api-staging.reactor.agencer.ai`), its library running both models on the bench's own Anthropic key.
Staging is where new code runs first; prod runs it once it is promoted.

```sh
cd bench
node cli.ts run --arm plain --domain files-ops --run-id 2026-11-10-agencer --seed 8 --days 4 --words new \
  --base-url https://api.anthropic.com/v1 --key ANTHROPIC_API_KEY --large claude-opus-5-5 --out runs/plain
node cli.ts run --arm playbook --client library --domain files-ops --run-id 2026-11-10-agencer --seed 8 --days 4 --words new \
  --base-url https://api-staging.reactor.agencer.ai/reactor/v1 --key REACTOR_API_KEY \
  --provider-url https://api.anthropic.com/v1 --provider-key ANTHROPIC_API_KEY \
  --large claude-opus-5-5 --small claude-haiku-5-5 --reply on --out runs/playbook
node cli.ts score --in runs/plain --in runs/playbook --out scored
```

`--key` and `--provider-key` name environment variables; the keys themselves are never on a command line.
