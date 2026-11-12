# repeat-bill

A benchmark of what an AI agent's model bill does when its work repeats: the same kinds of tool jobs, asked again in
new words with new data, with quality held. Built by Agencer to measure Reactor, and open so anyone can run it, check
our numbers, or measure something else.

Everything is in [`bench/`](bench/):

- [`bench/README.md`](bench/README.md): the desks, the arms, how to run it and read its table;
- [`bench/METHOD.md`](bench/METHOD.md): what a valid run is and how the saving is computed;
- [`bench/SUBMIT.md`](bench/SUBMIT.md): how to hand in a run;
- [`bench/results/`](bench/results/): the published runs, each with the exact commands that produced it;
- [`bench/outside/`](bench/outside/): the same jobs run by a plain agent written with the OpenAI SDK, direct and
  through Reactor, as a customer would run it.

The playbook arm runs an agent through [`@agencer/reactor`](https://www.npmjs.com/package/@agencer/reactor), the
Reactor client library, from npm. The plain arm needs nothing of ours: only a model provider.

Apache-2.0, as [`LICENSE`](LICENSE) says.
