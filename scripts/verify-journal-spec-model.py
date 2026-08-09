#!/usr/bin/env python3
"""Exhaustive bounded checks for the IncrementalGraph journal specification."""
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
    generation: tuple[int, str] | None = None

    @property
    def id(self): return (self.sequence, self.author)

G1 = Entry(1, "A", "K", "add", 10)
E1 = Entry(2, "B", "K", "edit", 11, G1.id)
I1 = Entry(3, "A", "K", "invalidate", 12, G1.id)
D1 = Entry(4, "B", "K", "delete", 13)
G2 = Entry(5, "A", "K", "add", 20)
E2 = Entry(6, "B", "K", "edit", 20, G2.id)
V2 = Entry(7, "A", "K", "validate", 21, G2.id)
UNIVERSE = (G1, E1, I1, D1, G2, E2, V2)

def valid(es):
    ids = {e.id: e for e in es}
    return all(e.generation is None or
               (e.generation in ids and ids[e.generation].action == "add" and
                ids[e.generation].key == e.key) for e in es)

def presence(es):
    xs = [e for e in es if e.action in ("add", "delete")]
    return max(xs, key=lambda e: e.id) if xs else None

def value_heads(es, g):
    xs = [e for e in es if (e.action == "add" and e.id == g.id) or
          (e.action == "edit" and e.generation == g.id)]
    out = {}
    for e in xs:
        if e.author not in out or out[e.author].sequence < e.sequence: out[e.author] = e
    return frozenset(out.values())

def freshness_heads(es, g):
    xs = [e for e in es if e.action in ("invalidate", "validate") and e.generation == g.id]
    out = {}
    for e in xs:
        k = (e.author, e.action)
        if k not in out or out[k].sequence < e.sequence: out[k] = e
    return frozenset(out.values())

def compact(es):
    es = frozenset(es)
    maxima = {}
    for e in es:
        k = (e.author, e.key, e.action)
        if k not in maxima or maxima[k].sequence < e.sequence: maxima[k] = e
    keep = set(maxima.values())
    p = presence(es)
    if p and p.action == "add":
        keep |= set(value_heads(es, p))
        keep |= set(freshness_heads(es, p))
    ids = {e.id: e for e in es}
    for e in tuple(keep):
        if e.generation is not None: keep.add(ids[e.generation])
    return frozenset(keep)

def projections(es):
    p = presence(es)
    if not p or p.action != "add":
        return (p, frozenset(), frozenset(), frozenset())
    vh = value_heads(es, p)
    canonical_inputs = frozenset(
        (t, max((e.id for e in vh if e.time == t))) for t in {e.time for e in vh})
    return (p, vh, freshness_heads(es, p), canonical_inputs)

VALID = [frozenset(c) for n in range(len(UNIVERSE)+1)
         for c in combinations(UNIVERSE, n) if valid(c)]
COMPACT = sorted(set(map(compact, VALID)), key=lambda x: tuple(sorted(x)))
for j in VALID:
    assert compact(compact(j)) == compact(j)
    assert projections(compact(j)) == projections(j)
for a, b in product(COMPACT, repeat=2):
    join = compact(a | b)
    assert join == compact(b | a)
    assert compact(a | a) == a
for a, b, c in product(COMPACT, repeat=3):
    assert compact(compact(a | b) | c) == compact(a | compact(b | c))
    assert compact(compact(a) | b) == compact(a | b)
for a, b in product(VALID, repeat=2):
    assert compact(compact(a) | b) == compact(a | b)

@dataclass(frozen=True)
class Stored:
    entries: tuple[tuple[str, int], ...]  # logical id -> local index, encoded as label/index
    watermark: int

def put(state, label):
    d = dict(state.entries)
    if label in d: return state
    w = state.watermark + 1; d[label] = w
    return Stored(tuple(sorted(d.items())), w)

def touch(state, label):
    d = dict(state.entries); w = state.watermark + 1; d[label] = w
    return Stored(tuple(sorted(d.items())), w)

def remove_and_cover(state, removed, witness):
    d = dict(state.entries)
    for x in removed: d.pop(x, None)
    base = Stored(tuple(sorted(d.items())), state.watermark)
    return touch(base, witness)

def issued_cursors(state):
    return [(-1, len(ACTIONS)-1)] + [
        (idx, ordinal) for _, idx in state.entries for ordinal in range(len(ACTIONS))]

def query(state, cursor):
    return {(label, action) for label, idx in state.entries
            for ordinal, action in enumerate(ACTIONS) if (idx, ordinal) > cursor}

# Exhaust all operation words through depth five. Each graph action records every pre-action cursor.
ops = ("installK1", "installK2", "installL", "touchK", "touchL", "compactK", "noop")
states_checked = 0; obligations_checked = 0; max_records = 0
for word in product(ops, repeat=5):
    s = Stored((), 0); obligations = []
    for op in word:
        before = s
        if op.startswith("install"):
            label = op.removeprefix("install")
            s = put(s, label)
            if s != before:
                obligations += [(c, label[0], a) for c in issued_cursors(before) for a in ACTIONS]
        elif op == "touchK" and any(k.startswith("K") for k, _ in s.entries):
            witness = max(k for k, _ in s.entries if k.startswith("K")); s = touch(s, witness)
            obligations += [(c, "K", a) for c in issued_cursors(before) for a in ACTIONS]
        elif op == "touchL" and any(k.startswith("L") for k, _ in s.entries):
            witness = max(k for k, _ in s.entries if k.startswith("L")); s = touch(s, witness)
            obligations += [(c, "L", a) for c in issued_cursors(before) for a in ACTIONS]
        elif op == "compactK" and all(k in dict(s.entries) for k in ("K1", "K2")):
            s = remove_and_cover(s, ("K1",), "K2")
        elif op == "noop":
            # Models a repeated equivalent settled synchronization.
            assert s == before
        max_records = max(max_records, len(s.entries))
    for cursor, key, action in obligations:
        assert any(label.startswith(key) and a == action for label, a in query(s, cursor))
        obligations_checked += 1
    settled = s
    for _ in range(3):
        assert s == settled  # no graph/logical/index/watermark change
    states_checked += 1
assert max_records <= 3  # only K1, K2, L exist; touches never add records

print(f"valid logical subsets: {len(VALID)}")
print(f"distinct compact logical states: {len(COMPACT)}")
print(f"merge triples checked: {len(COMPACT) ** 3}")
print(f"compaction closure pairs checked: {len(VALID) ** 2}")
print(f"cursor operation words checked: {states_checked}")
print(f"cursor obligations checked: {obligations_checked}")
print(f"maximum stored logical records: {max_records}")
print("all exhaustive bounded journal checks passed")
