#!/usr/bin/env python3
"""Exhaustive bounded A -> D -> K observatory-locking state machine."""
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class State:
    a_value: int
    a_fresh: bool
    d_value: int
    d_fresh: bool
    k_phase: str = "outside"       # outside, pulling, consumed, published
    a_pull: str = "idle"           # idle, fresh, changing, complete
    d_pull: str = "idle"           # idle, holding, waiting_a, returned
    d_path: str | None = None       # fresh or stale
    k_consumed_d: int | None = None


def reachable_invariant(state):
    """Fresh D has a complete validity cone through A."""
    # A can be stale while D is fresh only after K consumed D and a forbidden
    # late transition occurred. No allowed transition may create that state.
    return not (state.d_fresh and not state.a_fresh)


def successors(state):
    """Return individual scheduler steps allowed by dome and telescope rules."""
    out = []

    # The incompatible invalidation phase establishes the only precondition
    # from which a later nighttime pull(A) may change A. Propagation consumes
    # D's incoming validity proof before any such computor can start.
    if (state.k_phase == "outside" and state.a_pull == "idle" and
            state.d_pull == "idle" and state.a_fresh):
        out.append(("invalidate A and propagate D stale",
                    replace(state, a_fresh=False, d_fresh=False)))

    # A competing nighttime pull may begin before or around pull(D). Telescope
    # ownership is explicit until its fresh return or changed-value publication.
    if state.a_pull == "idle":
        mode = "fresh" if state.a_fresh else "changing"
        out.append((f"pull(A) starts {mode}", replace(state, a_pull=mode)))

    if state.k_phase == "outside":
        out.append(("pull(K) enters nighttime", replace(state, k_phase="pulling")))

    if state.k_phase == "pulling" and state.d_pull == "idle":
        out.append(("pull(D) acquires telescope", replace(state, d_pull="holding")))

    if state.d_pull == "holding":
        if state.d_fresh:
            # The reachable-state invariant is the premise of this fast path.
            assert state.a_fresh
            out.append(("pull(D) fresh fast return",
                        replace(state, d_pull="returned", d_path="fresh",
                                k_phase="consumed", k_consumed_d=state.d_value)))
        elif state.a_pull in ("fresh", "changing"):
            out.append(("stale pull(D) waits for A telescope",
                        replace(state, d_pull="waiting_a", d_path="stale")))
        else:
            # Recursive pull(A) owns A's free telescope. It either fast-returns
            # or publishes before D computes, exactly as the real nested pull.
            new_a = state.a_value if state.a_fresh else state.a_value + 1
            out.append(("stale pull(D) recursively settles A and returns",
                        replace(state, a_value=new_a, a_fresh=True,
                                d_value=new_a, d_fresh=True, d_pull="returned",
                                d_path="stale", k_phase="consumed",
                                k_consumed_d=new_a)))

    if state.a_pull == "fresh":
        out.append(("pull(A) fresh fast no-op",
                    replace(state, a_pull="complete")))

    if state.a_pull == "changing":
        # A was stale before its computor ran. Reachability requires staleness
        # already to have propagated to D, so D cannot have fast-returned.
        assert not state.d_fresh
        out.append(("pull(A) publishes changed value and propagates D stale",
                    replace(state, a_value=state.a_value + 1, a_fresh=True,
                            d_fresh=False, a_pull="complete")))

    if state.d_pull == "waiting_a" and state.a_pull == "complete":
        out.append(("pull(D) acquires released A telescope and returns",
                    replace(state, d_value=state.a_value, d_fresh=True,
                            d_pull="returned", k_phase="consumed",
                            k_consumed_d=state.a_value)))

    if state.k_phase == "consumed":
        out.append(("pull(K) publishes fresh",
                    replace(state, k_phase="published")))

    return out


# The exhaustive scheduler can keep this cone fresh or perform the explicit
# incompatible invalidation/propagation step before nighttime begins.
initial_states = (State(a_value=1, a_fresh=True, d_value=1, d_fresh=True),)
frontier = [(state, ()) for state in initial_states]
visited = set(initial_states)
transitions = publications = fast_returns = stale_returns = waits = 0
attempted_late_a_publications = 0

while frontier:
    state, trace = frontier.pop()
    assert reachable_invariant(state), trace
    for label, after in successors(state):
        transitions += 1
        next_trace = trace + (label,)
        assert reachable_invariant(after), next_trace
        if label == "pull(D) fresh fast return":
            fast_returns += 1
        if "pull(D)" in label and label.endswith("returns"):
            stale_returns += 1
        if label == "stale pull(D) waits for A telescope":
            waits += 1
        if label == "pull(A) publishes changed value and propagates D stale":
            if state.k_consumed_d is not None:
                attempted_late_a_publications += 1
            assert state.k_consumed_d is None, next_trace
        if label == "pull(K) publishes fresh":
            publications += 1
            assert after.k_consumed_d == after.d_value
            assert after.d_fresh
        if after not in visited:
            visited.add(after)
            frontier.append((after, next_trace))

assert fast_returns > 0 and stale_returns > 0 and waits > 0
assert attempted_late_a_publications == 0

print(f"reachable A->D->K locking states: {len(visited)}")
print(f"allowed scheduler transitions checked: {transitions}")
print(f"successful K publications checked: {publications}")
print(f"D fresh fast returns checked: {fast_returns}")
print(f"D stale recursive returns checked: {stale_returns}")
print(f"D waits on in-flight A telescope checked: {waits}")
print("late value-changing A publications after K consumed D: 0")
print("A->D->K nighttime dependency-stability checks passed")
