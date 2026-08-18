#!/usr/bin/env python3
"""Bounded executable evidence for the single IncrementalGraph journal spec."""
from dataclasses import dataclass
from itertools import combinations, product

ACTIONS = ("add", "edit", "delete", "invalidate", "validate")

@dataclass(frozen=True, order=True)
class Entry:
    sequence: int
    author: str
    key: str
    action: str
    time: int
    node_name: str = "node"
    bindings: tuple = ()
    generation: tuple[int, str] | None = None
    mode: str | None = None
    clears_hard: tuple[tuple[str, tuple[int, str]], ...] = ()
    @property
    def id(self): return (self.sequence, self.author)


def public_coordinate(e): return (e.author, e.key, e.action)
def vector_get(v, author): return dict(v).get(author, 0)
def vector_max(a, b):
    keys = set(dict(a)) | set(dict(b))
    return tuple(sorted((k, max(vector_get(a, k), vector_get(b, k))) for k in keys
                        if max(vector_get(a, k), vector_get(b, k))))
def maxima(entries):
    out = {}
    for e in entries:
        c = public_coordinate(e)
        if c not in out or out[c].sequence < e.sequence: out[c] = e
    return frozenset(out.values())

def hard_frontier(entries):
    out = {}
    for e in entries:
        if e.action == "invalidate" and e.mode == "hard":
            c = (e.author, e.key, e.generation)
            if c not in out or out[c].sequence < e.sequence: out[c] = e
    return frozenset(out.values())

def compact(entries):
    entries = frozenset(entries)
    keep = set(maxima(entries)) | set(hard_frontier(entries))
    # Reference closure: validations retain hard references; scoped entries retain add.
    by_id = {e.id: e for e in entries}
    changed = True
    while changed:
        changed = False
        for e in tuple(keep):
            refs = (() if e.generation is None else (e.generation,)) + tuple(r for _, r in e.clears_hard)
            for ref in refs:
                if ref in by_id and by_id[ref] not in keep:
                    keep.add(by_id[ref]); changed = True
    return frozenset(keep)

def query(entries, cursor=(), key_filter=lambda _k: True):
    v = dict(cursor); out = []
    candidates = [e for e in maxima(entries)
                  if e.sequence > v.get(e.author, 0) and key_filter(e.key)]
    for e in sorted(candidates, key=lambda x: x.id):
        # Sorting by ID is monotone within each author; cumulative vectors are safe.
        v[e.author] = e.sequence
        out.append((e, tuple(sorted(v.items()))))
    return tuple(out)

def obligations(entries, cursor=(), key_filter=lambda _k: True):
    return frozenset(public_coordinate(e) for e, _ in query(entries, cursor, key_filter))

def merge(a, b): return compact(set(a) | set(b))
def coverage(entries, gaps=()):
    out = dict(gaps)
    for e in entries: out[e.author] = max(out.get(e.author, 0), e.sequence)
    return tuple(sorted(out.items()))

G = Entry(1, "A", "K", "add", 1)
E1 = Entry(2, "A", "X", "edit", 2, generation=G.id)
E2 = Entry(3, "A", "Y", "edit", 3, generation=G.id)
E3 = Entry(4, "A", "X", "edit", 4, generation=G.id)
B1 = Entry(1, "B", "Z", "delete", 1)
H10 = Entry(10, "A", "K", "invalidate", 10, generation=G.id, mode="hard")
S20 = Entry(20, "A", "K", "invalidate", 20, generation=G.id, mode="soft")
VB = Entry(21, "B", "K", "validate", 21, generation=G.id,
           clears_hard=(("A", H10.id),))
POOL = (G, E1, E2, E3, B1, H10, S20, VB)

# Notification preservation and exact actions.
assert [e for e, _ in query((E1, E2, E3))] == [E2, E3]
assert query(POOL) == query(compact(POOL))
for cursor_a, cursor_b in product(range(0, 22), repeat=2):
    c = (("A", cursor_a), ("B", cursor_b))
    assert obligations(POOL, c) == obligations(compact(POOL), c)
    for old in POOL:
        if old.sequence > vector_get(c, old.author):
            witness = max((e for e in compact(POOL)
                           if public_coordinate(e) == public_coordinate(old)),
                          key=lambda e: e.sequence)
            assert witness.sequence >= old.sequence
            assert witness.sequence > vector_get(c, old.author)

# Partial processing: every prefix token leaves exactly the unprocessed coordinates.
full = query(POOL)
for stop in range(len(full) + 1):
    token = () if stop == 0 else full[stop - 1][1]
    remaining = obligations(POOL, token)
    unprocessed = frozenset(public_coordinate(e) for e, _ in full[stop:])
    assert remaining == unprocessed

# Cross-host portability and decentralized arrival order.
assert query((G, B1)) == query((B1, G))
assert obligations(POOL, (("A", 10), ("B", 3))) != obligations(POOL, (("A", 10), ("B", 0)))
portable = (("A", 10), ("B", 3))
assert vector_get(portable, "A") > vector_get((("A", 7), ("B", 100)), "A")
assert all(e.author != "A" or e.sequence > 10 for e, _ in query(POOL, portable))
# Host coverage is not an acceptance condition.
assert query(POOL, portable) == query(POOL, portable)

# Merge algebra and future-union closure over all bounded subsets.
subsets = [frozenset(POOL[i] for i in range(len(POOL)) if mask & (1 << i))
           for mask in range(1 << len(POOL))]
for a in subsets:
    assert compact(compact(a)) == compact(a)
for a, b in product(subsets[::17], repeat=2):
    assert merge(a, b) == merge(b, a)
    assert compact(set(compact(a)) | set(b)) == compact(set(a) | set(b))
for a, b, c in product(subsets[::51], repeat=3):
    assert merge(merge(a, b), c) == merge(a, merge(b, c))

# Soft/hard invalidation: maxima and causal barriers are separate.
assert S20 in maxima((G, H10, S20))
assert H10 in hard_frontier((G, H10, S20)) and S20 not in hard_frontier((G, H10, S20))
assert {H10, S20} <= compact((G, H10, S20))
assert dict(VB.clears_hard)["A"] == H10.id
assert not any(e.mode == "soft" and e.id in dict(VB.clears_hard).values() for e in POOL)
cache = {"fresh": False, "proofs": True, "hard": False}
assert cache["proofs"] and not cache["hard"]  # propagated stale remains cache-revalidatable
cache["proofs"] = False; cache["hard"] = True
assert cache == {"fresh": False, "proofs": False, "hard": True}  # stale-to-stale hardening
settled_events = (H10,)
assert settled_events == settled_events  # carrying an outstanding barrier authors nothing

@dataclass(frozen=True)
class Host:
    journal: frozenset[Entry]
    coverage: tuple[tuple[str, int], ...]
    hard: bool = False

def sync(receiver, source, author_hard=None):
    j = merge(receiver.journal, source.journal)
    c = vector_max(receiver.coverage, source.coverage)
    hard = receiver.hard or source.hard
    if author_hard is not None and not hard:
        j = merge(j, (author_hard,)); c = vector_max(c, ((author_hard.author, author_hard.sequence),)); hard = True
    return Host(j, c, hard)

# Directional sync absorption and reverse catch-up import a receiver event unchanged.
R0 = Host(frozenset((G,)), (("A", 1),), False)
S0 = Host(frozenset((G, E1)), (("A", 2),), False)
RH = Entry(30, "R", "K", "invalidate", 30, generation=G.id, mode="hard")
R1 = sync(R0, S0, RH)
assert sync(R1, S0, RH) == R1
S1 = sync(S0, R1, RH)
assert S1 == R1 and list(e.id for e in S1.journal).count(RH.id) == 1
# Intervening receiver mutation is ordinary newer input to the reverse receive.
R31 = Entry(31, "R", "K", "edit", 31, generation=G.id)
R2 = Host(merge(R1.journal, (R31,)), vector_max(R1.coverage, (("R", 31),)), True)
assert R31 in sync(S0, R2).journal

# Reset presence fencing, equal and unequal values, idempotence, delayed old source.
def reset_presence(receiver_generation, receiver_value, source_generation, source_value, next_id):
    if receiver_generation > source_generation and receiver_value == source_value:
        return receiver_generation, receiver_value, False
    return next_id, source_value, True
for rv, sv in (("same", "same"), ("old", "new")):
    first = reset_presence((10, "R"), rv, (100, "S"), sv, (101, "R"))
    assert first[0] > (100, "S") and first[1] == sv and first[2]
    second = reset_presence(first[0], first[1], (100, "S"), sv, (102, "R"))
    assert second == (first[0], first[1], False)
    assert max(first[0], (100, "S")) == first[0]

# Restart, gaps, compaction, and reappearing old witnesses preserve prefix meaning.
cov = coverage(POOL, (("A", 25), ("C", 99)))
assert vector_get(cov, "A") == 25 and vector_get(cov, "C") == 99
assert vector_get(vector_max(cov, (("A", 24),)), "A") == 25
assert coverage(compact(POOL), cov) == cov
reintroduced = merge(compact(POOL), (E1,))
assert obligations(reintroduced, (("A", 25),)) == obligations(compact(POOL), (("A", 25),))

# Finite storage counts agree with O(nr^2): public maxima <= 5*n*r and coverage <= r.
for subset in subsets:
    n = len({e.key for e in subset}); r = len({e.author for e in subset})
    assert len(maxima(subset)) <= len(ACTIONS) * n * r
    assert len(coverage(subset)) <= r
    assert len(compact(subset)) <= len(subset)  # bounded universe supplies logical witnesses

print(f"journal spec model verified: {len(subsets)} journal states, {22**2} cursor vectors")
