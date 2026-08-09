#!/usr/bin/env python3
"""Exhaustive bounded checks for the IncrementalGraph journal specification."""
from dataclasses import dataclass
from itertools import product

ACTIONS = ("add", "edit", "delete", "invalidate", "validate")

@dataclass(frozen=True, order=True)
class Entry:
    # None is only a compact Python encoding of the normative discriminated
    # union: add/delete have no generation field; the other variants require it.
    sequence: int
    author: str
    key: str
    action: str
    time: int
    generation: tuple[int, str] | None = None

    @property
    def id(self): return (self.sequence, self.author)

G1 = Entry(1, "A", "K", "add", 10)
GX = Entry(15, "B", "K", "add", 15)       # concurrent cross-author generation
D1 = Entry(16, "A", "K", "delete", 16)    # delete between generations
G2 = Entry(20, "A", "K", "add", 20)       # same-author successor and winner

# Losing-generation coordinate maxima exceed winning-generation witnesses.
E_OLD = Entry(110, "A", "K", "edit", 11, G1.id)
E_CUR = Entry(22, "A", "K", "edit", 20, G2.id)
I_OLD = Entry(111, "A", "K", "invalidate", 12, G1.id)
I_CUR = Entry(23, "A", "K", "invalidate", 21, G2.id)
V_OLD = Entry(112, "B", "K", "validate", 15, GX.id)
V_CUR = Entry(24, "B", "K", "validate", 22, G2.id)

# Winning coordinate maximum exceeds a losing entry; these also create cross-author heads.
E_LOW_OLD = Entry(2, "B", "K", "edit", 10, G1.id)
E_HIGH_CUR = Entry(25, "B", "K", "edit", 20, G2.id)
I_CROSS_CUR = Entry(26, "B", "K", "invalidate", 21, G2.id)

# Composite atoms make every enumerated union generation-valid while representing
# materially distinct ordering classes.
ATOMS = (
    frozenset((G1, E_OLD, I_OLD)),
    frozenset((GX, V_OLD)),
    frozenset((D1,)),
    frozenset((G2, E_CUR, I_CUR, V_CUR)),
    frozenset((G1, E_LOW_OLD)),
    frozenset((G2, E_HIGH_CUR)),
    frozenset((G2, I_CROSS_CUR)),
)

def valid(es):
    ids = {e.id: e for e in es}
    for e in es:
        if e.action in ("add", "delete"):
            if e.generation is not None:
                return False
            continue
        if e.action not in ("edit", "invalidate", "validate"):
            return False
        if e.generation is None:
            return False
        if (e.generation not in ids or
                ids[e.generation].action != "add" or
                ids[e.generation].key != e.key):
            return False
    return True

# The nullable Python field is rejected in every shape the normative union
# cannot represent.
assert not valid((G1, Entry(200, "B", "K", "add", 30, G1.id)))
assert not valid((G1, Entry(201, "B", "K", "delete", 30, G1.id)))
assert not valid((G1, Entry(202, "B", "K", "edit", 30)))
assert not valid((G1, Entry(203, "B", "K", "invalidate", 30)))
assert not valid((G1, Entry(204, "B", "K", "validate", 30)))

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
        return (p, None, frozenset(), frozenset(), frozenset(), frozenset())
    vh = value_heads(es, p)
    canonical_inputs = frozenset(
        (t, max((e.id for e in vh if e.time == t))) for t in {e.time for e in vh})
    required_adds = frozenset(
        e.generation for e in es if e.generation is not None and
        (e in vh or e in freshness_heads(es, p)))
    return (p, p.id, vh, canonical_inputs, freshness_heads(es, p), required_adds)

VALID = []
for mask in range(1 << len(ATOMS)):
    state = frozenset().union(*(ATOMS[i] for i in range(len(ATOMS)) if mask & (1 << i)))
    assert valid(state)
    VALID.append(state)
VALID = sorted(set(VALID), key=lambda x: tuple(sorted(x)))
COMPACT = sorted(set(map(compact, VALID)), key=lambda x: tuple(sorted(x)))

# Explicitly prove the witness cases are present and retained.
hard = frozenset().union(ATOMS[0], ATOMS[1], ATOMS[3])
hard_compact = compact(hard)
assert E_OLD in hard_compact and E_CUR in hard_compact
assert I_OLD in hard_compact and I_CUR in hard_compact
assert V_OLD in hard_compact and V_CUR in hard_compact
assert (E_OLD.sequence > E_CUR.sequence and
        I_OLD.sequence > I_CUR.sequence and
        V_OLD.sequence > V_CUR.sequence)

for j in VALID:
    assert compact(compact(j)) == compact(j)
    assert projections(compact(j)) == projections(j)
for a, b in product(COMPACT, repeat=2):
    assert compact(a | b) == compact(b | a)
    assert compact(a | a) == a
for a, b, c in product(COMPACT, repeat=3):
    assert compact(compact(a | b) | c) == compact(a | compact(b | c))
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

# Exhaust every four-operation word and check obligations after every prefix.
ops = ("installK1", "authorK2", "installL", "graphAddK", "graphDeleteK",
       "graphInvalidateK", "graphValidateL", "compactK", "graphCompactK", "noop")
states_checked = 0; prefixes_checked = 0; obligations_checked = 0; max_records = 0
for word in product(ops, repeat=4):
    s = Stored((), 0); obligations = []
    for op in word:
        before = s
        if op in ("installK1", "authorK2", "installL"):
            label = {"installK1": "K1", "authorK2": "K2", "installL": "L"}[op]
            s = put(s, label)
            if s != before:
                key = "L" if op == "installL" else "K"
                action = {"installK1": "add", "authorK2": "edit",
                          "installL": "validate"}[op]
                obligations += [(c, key, action) for c in issued_cursors(before)]
        elif op.startswith("graph") and op != "graphCompactK":
            key = "L" if op == "graphValidateL" else "K"
            candidates = [k for k, _ in s.entries if k.startswith(key)]
            if candidates:
                witness = max(candidates); old_count = len(s.entries)
                s = touch(s, witness)
                assert len(s.entries) == old_count
                action = {"graphAddK": "add", "graphDeleteK": "delete",
                          "graphInvalidateK": "invalidate",
                          "graphValidateL": "validate"}[op]
                obligations += [(c, key, action) for c in issued_cursors(before)]
        elif op == "compactK" and all(k in dict(s.entries) for k in ("K1", "K2")):
            s = remove_and_cover(s, ("K1",), "K2")
        elif op == "graphCompactK" and all(k in dict(s.entries) for k in ("K1", "K2")):
            # One transaction performs a graph edit, logical removal, and one covering touch.
            s = remove_and_cover(s, ("K1",), "K2")
            obligations += [(c, "K", "edit") for c in issued_cursors(before)]
        elif op == "noop":
            assert s == before

        indexes = [idx for _, idx in s.entries]
        assert len(indexes) == len(set(indexes))
        assert all(idx <= s.watermark for idx in indexes)
        max_records = max(max_records, len(s.entries))
        # Immediate prefix check, then preservation is rechecked after every later prefix.
        for cursor, key, action in obligations:
            assert any(label.startswith(key) and a == action for label, a in query(s, cursor))
            obligations_checked += 1
        prefixes_checked += 1
    settled = s
    for _ in range(3):
        assert s == settled
    states_checked += 1
assert max_records <= 3

print(f"valid bounded logical states: {len(VALID)}")
print(f"distinct compact logical states: {len(COMPACT)}")
print(f"merge triples checked: {len(COMPACT) ** 3}")
print(f"compaction closure pairs checked: {len(VALID) ** 2}")
print(f"cursor operation words checked: {states_checked}")
print(f"committed prefixes checked: {prefixes_checked}")
print(f"cursor obligation checks across prefixes: {obligations_checked}")
print(f"maximum stored logical records: {max_records}")
print("all exhaustive bounded journal checks passed")
