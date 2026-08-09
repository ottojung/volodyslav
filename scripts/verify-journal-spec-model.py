#!/usr/bin/env python3
"""Exhaustive bounded checks for the IncrementalGraph journal specification."""
from dataclasses import dataclass
from itertools import product

ACTIONS = ("add", "edit", "delete", "invalidate", "validate")

@dataclass(frozen=True, order=True)
class Entry:
    sequence: int
    author: str
    key: str
    action: str
    generation: tuple[int, str] | None = None
    clears: tuple[tuple[str, tuple[int, str]], ...] = ()
    @property
    def id(self): return (self.sequence, self.author)

G1 = Entry(1, "A", "K", "add")
G2 = Entry(20, "A", "K", "add")
IA1 = Entry(10, "A", "K", "invalidate", G1.id)
IC1 = Entry(11, "C", "K", "invalidate", G1.id)
VB_OLD = Entry(101, "B", "K", "validate", G1.id)  # saw neither invalidate
VB_A = Entry(102, "B", "K", "validate", G1.id, (("A", IA1.id),))
VD_C = Entry(103, "D", "K", "validate", G1.id, (("C", IC1.id),))
VE_BOTH = Entry(104, "E", "K", "validate", G1.id,
                (("A", IA1.id), ("C", IC1.id)))
IA2 = Entry(12, "A", "K", "invalidate", G1.id)
VE_LATER = Entry(105, "E", "K", "validate", G1.id,
                 (("A", IA2.id), ("C", IC1.id)))
I_NEW = Entry(21, "A", "K", "invalidate", G2.id)
V_NEW = Entry(22, "B", "K", "validate", G2.id, (("A", I_NEW.id),))

ENTRIES = (G1, IA1, IC1, VB_OLD, VB_A, VD_C, VE_BOTH, IA2, VE_LATER, G2, I_NEW, V_NEW)

def valid(es):
    ids = {e.id: e for e in es}
    for e in es:
        if e.action in ("add", "delete"):
            if e.generation is not None or e.clears: return False
            continue
        if e.generation not in ids or ids[e.generation].action != "add": return False
        if e.action != "validate" and e.clears: return False
        for author, ref in e.clears:
            i = ids.get(ref)
            if not i or i.action != "invalidate" or i.author != author:
                return False
            if i.key != e.key or i.generation != e.generation: return False
    return True

def presence(es):
    xs = [e for e in es if e.action in ("add", "delete")]
    return max(xs, key=lambda e: e.id) if xs else None

def frontier(es, generation):
    out = {}
    for e in es:
        if e.action == "invalidate" and e.generation == generation:
            if e.author not in out or out[e.author].sequence < e.sequence: out[e.author] = e
    return frozenset(out.values())

def covers(v, i):
    refs = dict(v.clears)
    return (v.action == "validate" and v.key == i.key and
            v.generation == i.generation and i.author in refs and
            refs[i.author][1] == i.author and refs[i.author][0] >= i.sequence)

def effective(es, generation):
    f = frontier(es, generation)
    return any(v.action == "validate" and v.generation == generation and
               all(covers(v, i) for i in f) for v in es)

def compact(es):
    es = frozenset(es); ids = {e.id: e for e in es}; keep = set()
    maxima = {}
    for e in es:
        c = (e.author, e.key, e.action)
        if c not in maxima or maxima[c].sequence < e.sequence: maxima[c] = e
    keep.update(maxima.values())
    p = presence(es)
    if p and p.action == "add":
        keep.update(frontier(es, p.id))
        for author in {e.author for e in es}:
            vs = [e for e in es if e.action == "validate" and
                  e.generation == p.id and e.author == author]
            if vs: keep.add(max(vs, key=lambda e: e.sequence))
    # Exact causal and generation references of every retained entry are closed.
    for e in tuple(keep):
        if e.generation is not None: keep.add(ids[e.generation])
        for _, ref in e.clears: keep.add(ids[ref])
    return frozenset(keep)

def projection(es):
    p = presence(es)
    if not p or p.action != "add": return (p, frozenset(), False)
    return (p, frontier(es, p.id), effective(es, p.id))

# Critical causal traces.
assert not effective({G1, VB_OLD, IA1}, G1.id)                 # high clock is not observation
assert effective({G1, IA1, VB_A}, G1.id)                     # actual observation
assert not effective({G1, IA1, IC1, VB_A, VD_C}, G1.id)      # partial proofs do not combine
assert effective({G1, IA1, IC1, VE_BOTH}, G1.id)             # one joined proof
assert not effective({G1, IA1, IC1, IA2, VE_BOTH}, G1.id)    # delayed later invalidate
assert effective({G1, IA1, IC1, IA2, VE_LATER}, G1.id)
assert projection({G1, IA1, VE_LATER, G2}) == (G2, frozenset(), False)
assert effective({G1, IA1, G2, I_NEW, V_NEW}, G2.id)         # generation isolation

# Reachable atoms include referenced entries, and same-author later validations
# carry componentwise-greater contexts (VE_BOTH <= VE_LATER).
ATOMS = (
    frozenset((G1,)), frozenset((G1, IA1)), frozenset((G1, IC1)),
    frozenset((G1, VB_OLD)), frozenset((G1, IA1, VB_A)),
    frozenset((G1, IC1, VD_C)), frozenset((G1, IA1, IC1, VE_BOTH)),
    frozenset((G1, IA1, IC1, IA2, VE_BOTH, VE_LATER)),
    frozenset((G2, I_NEW)), frozenset((G2, I_NEW, V_NEW)),
)
VALID = sorted({frozenset().union(*(ATOMS[i] for i in range(len(ATOMS)) if mask & (1 << i)))
                for mask in range(1 << len(ATOMS))}, key=lambda x: tuple(sorted(x)))
VALID = [s for s in VALID if valid(s)]
ACI_VALID = sorted({frozenset().union(*(ATOMS[i] for i in range(6) if mask & (1 << i)))
                    for mask in range(1 << 6)}, key=lambda x: tuple(sorted(x)))
ACI_VALID = [s for s in ACI_VALID if valid(s)]
COMPACT = sorted(set(map(compact, ACI_VALID)), key=lambda x: tuple(sorted(x)))

for j in VALID:
    assert compact(compact(j)) == compact(j)
    assert projection(compact(j)) == projection(j)
    assert valid(compact(j))  # no dangling generation or causal references
for a, b in product(VALID, repeat=2):
    assert compact(compact(a) | b) == compact(a | b)
for a, b in product(COMPACT, repeat=2):
    assert compact(a | b) == compact(b | a)
    assert compact(a | a) == a
for a, b, c in product(COMPACT, repeat=3):
    assert compact(compact(a | b) | c) == compact(a | compact(b | c))

# Finite structural check only: O(r) validations each contain O(r) references.
for j in COMPACT:
    r = len({e.author for e in j} | {a for e in j for a, _ in e.clears})
    payload = len(j) + sum(len(e.clears) for e in j)
    assert payload <= 5 * max(1, r) ** 2 + 5 * max(1, r)

# Optional compaction: immutable appends can grow raw state while its canonical
# representation remains bounded in this repeated-one-coordinate trace.
raw = {G1}
for sequence in range(200, 240):
    raw.add(Entry(sequence, "A", "K", "invalidate", G1.id))
assert len(raw) == 41 and len(compact(raw)) == 2

print(f"valid bounded logical states: {len(VALID)}")
print(f"distinct compact logical states: {len(COMPACT)}")
print(f"merge triples checked: {len(COMPACT) ** 3}")
print(f"compaction closure pairs checked: {len(VALID) ** 2}")
print("critical causal traces: 8")
print("raw repeated-mutation records: 41; compact records: 2")
print("all exhaustive bounded journal checks passed")
