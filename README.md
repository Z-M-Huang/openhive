# OpenHive

> Archived 2026-04-19. Keeping it public as a learning artifact.

OpenHive is my learning project. I wanted to understand the OpenClaw approach hands-on
and see how far you can push the "agent as a feature" idea, where the whole system is
one big LLM loop. User says something, the LLM decides what to do: spawn a team,
register a plugin, write a skill, follow whatever markdown rule applies. The system is
supposed to run itself.

Architecture is in the [wiki](https://github.com/Z-M-Huang/openhive/wiki):

- [Design Principles](https://github.com/Z-M-Huang/openhive/wiki/Design-Principles)
- [Architecture](https://github.com/Z-M-Huang/openhive/wiki/Architecture)
- [Rules Architecture](https://github.com/Z-M-Huang/openhive/wiki/Rules-Architecture)
- [Architecture Decisions](https://github.com/Z-M-Huang/openhive/wiki/Architecture-Decisions)

## Why I'm archiving

Interesting idea. For someone who doesn't write code, having an LLM run the
orchestration is probably a great experience. For me as a developer it isn't, and I
don't think it will be for a while.

What keeps bothering me is that the system keeps growing, and not because the *system*
actually needs it. Because the *LLM* needs it. Model misses a behavior, you patch it
with a rule. Misses again, you write another rule on top. Then a nudge in the prompt
to remind the model the earlier rule exists. After a while you're writing rules about
rules, the prompt is ten thousand tokens, and the model still occasionally ignores
half of them.

On top of that the model isn't deterministic. Same input, different run, different
result, depending on what was in context, what got cached, whether the rule the model
needed was near the top of the attention window or buried five rules deep. Fine for a
chat assistant. Not fine for something I want to actually depend on.

So the math gets weird. I could build the same workflow in N8N in a few days. I could
write the app from scratch in a week and know it works. Instead I spend a month
iterating on prompts hoping the model converges, and even then I'm not sure it holds
under slightly different input next month.

The trade is real: flexibility and a no-code feel, in exchange for losing
determinism. For some use cases that's worth it. For what I want to ship right now, it
isn't.

Or I'm wrong about all of this. Honestly not sure.

Maybe I'll come back to it once models get noticeably better at following procedural
rules. Or once I find a use case where the trade flips. Or if I figure out a hybrid
shape — deterministic spine, model only at the edges.

## If you have better ideas

Tell me. If you've made agent-first orchestration reliable enough to actually depend
on, or you think the whole approach is the wrong frame, open an issue or reach out. Happy
to compare notes.

## Running it

```bash
docker compose -f deployments/docker-compose.yml up -d
curl http://localhost:8080/health
wscat -c ws://localhost:8080/ws
```

Or from source: `bun install && bun run build && bun run test`.
