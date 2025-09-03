# Technical Specification: Mathematical Cron Field Calculation

## Overview

This document provides the detailed mathematical specifications for the field-based cron calculation algorithm. It defines the precise operations needed to implement the O(1) cron execution time calculator.

## Mathematical Foundations

### Field Value Sets
For a cron expression, each field defines a set of valid values:
- **M** = {valid minutes} ⊆ {0, 1, 2, ..., 59}
- **H** = {valid hours} ⊆ {0, 1, 2, ..., 23}  
- **D** = {valid days} ⊆ {1, 2, 3, ..., 31}
- **Mo** = {valid months} ⊆ {1, 2, 3, ..., 12}
- **W** = {valid weekdays} ⊆ {0, 1, 2, ..., 6} where 0=Sunday

### Core Operations

#### Next Value in Set
For a set S and current value v:
```
next_in_set(v, S) = {
    min{s ∈ S : s > v}     if such s exists
    min(S)                 otherwise
}
```

#### Previous Value in Set  
For a set S and current value v:
```
prev_in_set(v, S) = {
    max{s ∈ S : s < v}     if such s exists
    max(S)                 otherwise
}
```

#### Rollover Detection
```
rolled_over(v_new, v_old, S) = (v_new ≤ v_old) ∧ (v_new = min(S))
```

## Next Execution Algorithm

### Input
- Reference time: (y₀, mo₀, d₀, h₀, m₀)
- Cron field sets: M, H, D, Mo, W

### Algorithm Steps

#### Step 1: Initialize
```
t = next_minute_boundary(reference_time)
y, mo, d, h, m = t.year, t.month, t.day, t.hour, t.minute
carry = false
```

#### Step 2: Calculate Next Minute
```
m' = next_in_set(m, M)
if rolled_over(m', m, M):
    carry = true
m = m'
```

#### Step 3: Calculate Next Hour (if carry)
```
if carry:
    h' = next_in_set(h, H)
    if rolled_over(h', h, H):
        carry = true
        h = min(H)
        m = min(M)
    else:
        carry = false
        h = h'
        m = min(M)
```

#### Step 4: Calculate Next Day (if carry)
```
if carry:
    d' = next_valid_day_in_month(d, mo, y, D)
    if d' exists:
        carry = false
        d = d'
        h = min(H)
        m = min(M)
    else:
        carry = true
```

#### Step 5: Calculate Next Month (if carry)
```
if carry:
    mo' = next_in_set(mo, Mo)
    if rolled_over(mo', mo, Mo):
        y = y + 1
        mo = min(Mo)
    else:
        mo = mo'
    
    d = min(valid_days_in_month(mo, y) ∩ D)
    h = min(H)
    m = min(M)
```

#### Step 6: Apply Weekday Constraints
```
candidate = date(y, mo, d)
if weekday(candidate) ∉ W:
    (y, mo, d) = next_date_satisfying_weekday_constraint(candidate, W, Mo, D)
    h = min(H)
    m = min(M)
```

### Helper Functions

#### next_valid_day_in_month(d, mo, y, D)
```
days_in_month = {
    1: 31, 2: 28+leap(y), 3: 31, 4: 30, 5: 31, 6: 30,
    7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31
}

valid_days = D ∩ {1, 2, ..., days_in_month[mo]}
return min{day ∈ valid_days : day ≥ d} or null
```

#### next_date_satisfying_weekday_constraint(start_date, W, Mo, D)
```
for offset in [0, 1, 2, 3, 4, 5, 6]:
    candidate = start_date + offset days
    if weekday(candidate) ∈ W and 
       candidate.month ∈ Mo and 
       candidate.day ∈ D:
        return candidate
        
// If no date found in first week, find next valid month/day combination
// and search again (handles sparse constraints)
next_month_day = next_valid_month_day_after(start_date, Mo, D)
return next_date_satisfying_weekday_constraint(next_month_day, W, Mo, D)
```

## Previous Execution Algorithm

### Input
- Reference time: (y₀, mo₀, d₀, h₀, m₀)
- Cron field sets: M, H, D, Mo, W

### Algorithm Steps

#### Step 1: Initialize
```
t = current_minute_boundary(reference_time)
y, mo, d, h, m = t.year, t.month, t.day, t.hour, t.minute
underflow = false
```

#### Step 2: Calculate Previous Minute
```
m' = prev_in_set(m, M)
if underflowed(m', m, M):
    underflow = true
m = m'
```

#### Step 3: Calculate Previous Hour (if underflow)
```
if underflow:
    h' = prev_in_set(h, H)
    if underflowed(h', h, H):
        underflow = true
        h = max(H)
        m = max(M)
    else:
        underflow = false
        h = h'
        m = max(M)
```

#### Step 4: Calculate Previous Day (if underflow)
```
if underflow:
    d' = prev_valid_day_in_month(d, mo, y, D)
    if d' exists:
        underflow = false
        d = d'
        h = max(H)
        m = max(M)
    else:
        underflow = true
```

#### Step 5: Calculate Previous Month (if underflow)
```
if underflow:
    mo' = prev_in_set(mo, Mo)
    if underflowed(mo', mo, Mo):
        y = y - 1
        mo = max(Mo)
    else:
        mo = mo'
    
    d = max(valid_days_in_month(mo, y) ∩ D)
    h = max(H)
    m = max(M)
```

#### Step 6: Apply Weekday Constraints
```
candidate = date(y, mo, d)
if weekday(candidate) ∉ W:
    (y, mo, d) = prev_date_satisfying_weekday_constraint(candidate, W, Mo, D)
    h = max(H)
    m = max(M)
```

### Helper Functions

#### underflowed(v_new, v_old, S)
```
underflowed(v_new, v_old, S) = (v_new ≥ v_old) ∧ (v_new = max(S))
```

#### prev_valid_day_in_month(d, mo, y, D)
```
valid_days = D ∩ {1, 2, ..., days_in_month[mo]}
return max{day ∈ valid_days : day ≤ d} or null
```

## Complexity Proofs

### Time Complexity: O(1)

**Theorem**: Both next and previous execution algorithms complete in O(1) time.

**Proof**:
1. **Field calculations**: Each of the 5 fields (minute, hour, day, month, weekday) requires at most O(log k) operations where k is the size of the valid value set. Since k ≤ 60 for all fields, this is O(log 60) = O(1).

2. **Carry/underflow propagation**: In the worst case, all 5 fields cascade (e.g., 23:59 → 00:00 next day). This requires exactly 5 field operations = O(1).

3. **Weekday constraint resolution**: At most 7 iterations to find a valid weekday within a week = O(1).

4. **Month boundary handling**: Leap year calculation and days-in-month lookup are O(1) operations.

**Total**: O(1) + O(1) + O(1) + O(1) = O(1)

### Space Complexity: O(1)

**Theorem**: Both algorithms use O(1) space.

**Proof**: 
- Fixed number of variables: (y, mo, d, h, m, carry/underflow flags)
- Cron field sets have bounded size: |M| ≤ 60, |H| ≤ 24, |D| ≤ 31, |Mo| ≤ 12, |W| ≤ 7
- No recursion or dynamic data structures used
- Total space usage is constant regardless of input values

## Correctness Properties

### Property 1: Monotonicity
For next execution: if t₁ < t₂, then next_execution(t₁) ≤ next_execution(t₂)

### Property 2: Minimality  
next_execution(t) returns the smallest valid execution time strictly greater than t

### Property 3: Validity
The returned time always satisfies all cron field constraints

### Property 4: Inverse Relationship
For many cases: previous_execution(next_execution(t)) ≤ t < next_execution(t)

## Implementation Considerations

### Floating Point Concerns
All calculations use integer arithmetic only. No floating point precision issues.

### Overflow Handling
Year values are unbounded in practice. Implementation should handle reasonable year ranges (e.g., 1970-3000).

### Timezone Handling
Algorithm operates on timezone-aware DateTime objects. The mathematical operations preserve timezone information through the existing DateTime abstraction layer.

### Edge Case Validation
- **Invalid dates**: Feb 30, Sep 31, etc. are naturally excluded by days_in_month constraints
- **Leap year handling**: Leap year calculation is encapsulated in days_in_month function
- **Empty constraint sets**: Algorithm should validate that all field sets are non-empty

## Testing Validation

### Correctness Testing
1. **Equivalence testing**: Verify algorithm produces same results as current implementation
2. **Inverse testing**: Verify previous(next(t)) ≤ t < next(t) for valid cases  
3. **Boundary testing**: Test around month/year boundaries, leap years, DST transitions

### Performance Testing
1. **Timing tests**: Measure execution time across various cron expressions
2. **Scalability tests**: Verify O(1) behavior for large time spans
3. **Memory tests**: Confirm O(1) space usage

### Stress Testing
1. **Sparse schedules**: Yearly tasks, leap-year-only tasks
2. **Complex expressions**: Multiple constraints, ranges, lists
3. **Large time spans**: Decades into future/past

---

This specification provides the complete mathematical foundation for implementing the efficient cron calculation algorithm.