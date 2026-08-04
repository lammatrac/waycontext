# Retrieval quality


Every repository ships its own labelled dataset for free. A commit is a natural-language
description of an intent paired with the exact set of files that intent turned out to
touch — so replaying commits measures retrieval against real ground truth, in your
codebase, in your domain vocabulary, with nothing to annotate.

```bash
npm run eval -- myproject --commits 100 --k 10
```

Reports `recall@k` (of the files a commit touched, what fraction came back in the top k),
hit rate, and MRR. Merges, reverts, one-word subjects and sprawling refactors are
excluded; sampling is a deterministic stride, so two runs score the same commits and a
before/after comparison means something.

Read the absolute number sceptically — a commit message is a lossy description of a diff,
so perfect recall is neither achievable nor the goal. It is for comparing WayContext to
WayContext across a retrieval change.

> **Finding from the first run:** with `EMBEDDING_PROVIDER=none`, recall@10 on this
> repository's own history is **0.00** — `plainto_tsquery` ANDs every term, so a
> natural-language query returns nothing at all unless one symbol happens to contain all
> of its words. With embeddings on, the same 26 commits score recall@10 **0.66**, hit rate
> **0.92**, MRR **0.73**. The "degrades gracefully to full-text" story does not currently
> hold for natural-language queries.

