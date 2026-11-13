# 2026-11-12-agencer-same, support-ops

Both arms ran on 2026-11-12, seed 8, 4 days, `--words same`, from the same harness. The `harness_commit` both
`results.json` files record, `8bd05984facd8a139e7711b8c97c8ffe630e021b`, is a commit of Agencer's private repository, where `bench/` was developed. The
harness, the tasks, the scorer and `prices.json` in `bench/` here are that commit's, unchanged but for comments, a
name taken out of two sentences of the table's notes, and the import of the client library, which here is
`@agencer/reactor` from npm and there was the same library's source.

The playbook arm ran on a fresh account made for this arm alone, with a fresh key, and `--fresh-key-required`, which
refuses a key the key ledger has seen. Its notes carry no line that the ledger had seen the key: day 1 is cold. The large model is Claude Opus 5.5 and the small one
Claude Haiku 5.5, both on Anthropic's API. The playbook arm went through Reactor's staging deployment
(`api-staging.reactor.agencer.ai`), its library running both models on the bench's own Anthropic key. Staging is
where new code runs first; prod runs it once it is promoted.

```sh
cd bench
node cli.ts run --arm plain --domain support-ops --run-id 2026-11-12-agencer-same --seed 8 --days 4 --words same \
  --base-url https://api.anthropic.com/v1 --key ANTHROPIC_API_KEY --large claude-opus-5-5 --out runs/plain
node cli.ts run --arm playbook --client library --domain support-ops --run-id 2026-11-12-agencer-same --seed 8 --days 4 --words same \
  --fresh-key-required --base-url https://api-staging.reactor.agencer.ai/reactor/v1 --key REACTOR_API_KEY \
  --provider-url https://api.anthropic.com/v1 --provider-key ANTHROPIC_API_KEY \
  --large claude-opus-5-5 --small claude-haiku-5-5 --reply on --out runs/playbook
node cli.ts score --in runs/plain --in runs/playbook --out scored
```

`--key` and `--provider-key` name environment variables; the keys themselves are never on a command line.
