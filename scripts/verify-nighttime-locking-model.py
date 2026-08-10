#!/usr/bin/env python3
"""Bounded state-machine check of nighttime dependency stability."""
from dataclasses import dataclass


@dataclass(frozen=True)
class State:
    parent_phase: str = "outside"
    dependency_value: int = 1
    dependency_fresh: bool = False
    parent_read: int | None = None
    parent_published: int | None = None


def successors(state):
    """Return transitions permitted by dome mode and telescope serialization."""
    out = []
    if state.parent_phase == "outside":
        out.append(("parent enters nighttime", State("pulling", state.dependency_value,
                                                     state.dependency_fresh)))
        # Daytime/holiday graph writers can change a value only without a
        # nighttime holder. Their mutation also makes dependants stale.
        out.append(("incompatible writer commits", State("outside",
                                                          state.dependency_value + 1,
                                                          False)))
    elif state.parent_phase == "pulling":
        # Recursive pull commits before returning. A stale dependency computes
        # its current semantic result; a fresh one takes the fast path.
        out.append(("dependency returns", State("read", state.dependency_value,
                                                True, state.dependency_value)))
    elif state.parent_phase == "read":
        # A concurrent same-node dependency pull serializes after the completed
        # telescope section and can only take the fresh fast path.
        out.append(("concurrent dependency fresh fast path", state))
        out.append(("parent publishes", State("published", state.dependency_value,
                                              True, state.parent_read,
                                              state.parent_read)))
    elif state.parent_phase == "published":
        out.append(("parent releases nighttime", State("outside",
                                                       state.dependency_value,
                                                       state.dependency_fresh)))
    return out


initial = State()
frontier = [(initial, ())]
states = {initial}
transitions = 0
traces = 0
for _ in range(8):
    next_frontier = []
    for state, trace in frontier:
        for label, after in successors(state):
            transitions += 1
            next_trace = trace + (label,)
            # The forbidden publication is checked at every reachable step.
            assert not (after.parent_published is not None and
                        after.parent_published != after.dependency_value), next_trace
            if label == "parent publishes":
                traces += 1
                assert after.parent_read == after.dependency_value
            states.add(after)
            next_frontier.append((after, next_trace))
    frontier = next_frontier

# Explicit alleged counterexample prefix: the second pull is forced through the
# fresh fast path and cannot produce d2 while the parent's nighttime mode lives.
s = initial
for chosen in ("parent enters nighttime", "dependency returns",
               "concurrent dependency fresh fast path", "parent publishes"):
    label, s = next(pair for pair in successors(s) if pair[0] == chosen)
assert s.parent_read == s.dependency_value == s.parent_published == 1

print(f"reachable locking states: {len(states)}")
print(f"allowed transitions checked: {transitions}")
print(f"successful parent publications checked: {traces}")
print("explicit D -> K counterexample trace: concurrent D used fresh fast path")
print("nighttime dependency-stability checks passed")
