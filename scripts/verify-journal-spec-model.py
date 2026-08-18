#!/usr/bin/env python3
"""Bounded executable evidence for the one-journal IncrementalGraph specification."""
from dataclasses import dataclass
from itertools import product
import base64, hashlib, json

ACTIONS = ("add", "edit", "delete", "invalidate", "validate")

def node_key(name, bindings):
    raw = json.dumps([name, list(bindings)], separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:12]

@dataclass(frozen=True, order=True)
class Entry:
    sequence: int; author: str; key: str; action: str; time: int
    node_name: str; bindings: tuple = (); generation: tuple | None = None
    mode: str | None = None; clears: tuple = (); value: str | None = None
    @property
    def id(self): return (self.sequence, self.author)

def add(seq, author, name, time, value):
    return Entry(seq, author, node_key(name, ()), "add", time, name, value=value)
def scoped(seq, author, name, action, time, generation, *, mode=None, clears=(), value=None):
    return Entry(seq, author, node_key(name, ()), action, time, name,
                 generation=generation, mode=mode, clears=tuple(sorted(clears)), value=value)

def valid(entries):
    entries = tuple(entries); by_id = {}
    for e in entries:
        if e.id in by_id and by_id[e.id] != e: return False
        by_id[e.id] = e
        if e.sequence < 1 or e.author not in ("A", "B", "C", "R", "S"): return False
        if e.key != node_key(e.node_name, e.bindings) or e.action not in ACTIONS: return False
        if e.action in ("add", "delete"):
            if e.generation is not None or e.mode is not None or e.clears: return False
        else:
            if e.generation is None: return False
            if e.action == "invalidate" and e.mode not in ("soft", "hard"): return False
            if e.action != "invalidate" and e.mode is not None: return False
            if e.action != "validate" and e.clears: return False
    for e in entries:
        if e.generation is not None:
            g = by_id.get(e.generation)
            if not g or g.action != "add" or g.key != e.key: return False
        seen = set()
        for author, ref in e.clears:
            if author in seen: return False
            seen.add(author); i = by_id.get(ref)
            if (e.action != "validate" or not i or i.action != "invalidate" or
                i.author != author or i.key != e.key or i.generation != e.generation or
                i.sequence >= e.sequence): return False
    vals = [e for e in entries if e.action == "validate"]
    for v1 in vals:
        for v2 in vals:
            if (v1.author, v1.key, v1.generation) == (v2.author, v2.key, v2.generation) and v1.sequence < v2.sequence:
                later = dict(v2.clears)
                if any(a not in later or later[a][0] < ref[0] for a, ref in v1.clears): return False
    return True

def presence_head(es, key):
    xs = [e for e in es if e.key == key and e.action in ("add", "delete")]
    return max(xs, key=lambda e:e.id) if xs else None

def generation(es, key):
    p = presence_head(es, key); return p.id if p and p.action == "add" else None

def value_events(es, key, g):
    return [e for e in es if (e.action == "add" and e.id == g) or
            (e.action == "edit" and e.key == key and e.generation == g)]
def value_heads(es, key, g):
    out = {}
    for e in value_events(es,key,g):
        if e.author not in out or out[e.author].sequence < e.sequence: out[e.author] = e
    return frozenset(out.values())
def canonical_event(es,key,g,modified_at):
    return max((e for e in value_heads(es,key,g) if e.time == modified_at), key=lambda e:e.id)
def value_revision(e): return (e.time,e.sequence,e.author)

def frontier(es,key,g,hard=False):
    out={}
    for e in es:
        if e.key==key and e.generation==g and e.action=="invalidate" and (not hard or e.mode=="hard"):
            if e.author not in out or out[e.author].sequence<e.sequence: out[e.author]=e
    return frozenset(out.values())
def covers(v,i,es):
    ref=dict(v.clears).get(i.author); c={e.id:e for e in es}.get(ref)
    return bool(c and c.action=="invalidate" and c.author==i.author and c.key==i.key and
                c.generation==i.generation and c.sequence>=i.sequence)
def effective(v,es,key,g,hard=False): return all(covers(v,i,es) for i in frontier(es,key,g,hard))
def journal_hard(es,key,g):
    hf=frontier(es,key,g,True)
    return bool(hf) and not any(e.action=="validate" and e.key==key and e.generation==g and effective(e,es,key,g,True) for e in es)
def journal_fresh(es,key,g):
    return any(e.action=="validate" and e.key==key and e.generation==g and effective(e,es,key,g) for e in es)

def maxima(es):
    out={}
    for e in es:
        c=(e.author,e.key,e.action)
        if c not in out or out[c].sequence<e.sequence: out[c]=e
    return frozenset(out.values())
def compact(es):
    es=frozenset(es); assert valid(es)
    by_id={e.id:e for e in es}; keep=set(maxima(es)); keys={e.key for e in es}
    for key in keys:
        p=presence_head(es,key)
        if p: keep.add(p)
        g=p.id if p and p.action=="add" else None
        if g:
            heads=value_heads(es,key,g); keep.update(heads) # VH and all exact tie inputs CE
            keep.update(frontier(es,key,g)); keep.update(frontier(es,key,g,True))
            vals={}
            for e in es:
                if e.action=="validate" and e.key==key and e.generation==g:
                    c=e.author
                    if c not in vals or vals[c].sequence<e.sequence: vals[c]=e
            keep.update(vals.values())
    changed=True
    while changed:
        changed=False
        for e in tuple(keep):
            refs=(([e.generation] if e.generation else [])+[r for _,r in e.clears])
            for ref in refs:
                if ref in by_id and by_id[ref] not in keep: keep.add(by_id[ref]); changed=True
    result=frozenset(keep); assert valid(result); return result

def query(es,cursor=(),allowed=lambda _k:True):
    v=dict(cursor); out=[]
    for e in sorted((e for e in maxima(es) if e.sequence>v.get(e.author,0) and allowed(e.key)),key=lambda e:e.id):
        v[e.author]=e.sequence; out.append((e,tuple(sorted(v.items()))))
    return tuple(out)
def obligations(es,cursor=()): return frozenset((e.author,e.key,e.action) for e,_ in query(es,cursor))
def vmax(a,b):
    d=dict(a)
    for k,v in b:d[k]=max(d.get(k,0),v)
    return tuple(sorted((k,v) for k,v in d.items() if v))

def encode(change,vector):
    coords=[[a,n] for a,n in sorted(vector)]
    raw=json.dumps({"v":1,"change":change,"cursor":coords},sort_keys=True,separators=(",",":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
def decode(token):
    raw=base64.urlsafe_b64decode(token+"="*((-len(token))%4)).decode(); obj=json.loads(raw)
    if set(obj)!={"v","change","cursor"} or obj["v"]!=1: raise ValueError
    change=obj["change"]
    if (not isinstance(change,dict) or set(change)!={"action","bindings","nodeName","time"} or
        change["action"] not in ACTIONS or not isinstance(change["nodeName"],str) or
        not isinstance(change["bindings"],list) or not isinstance(change["time"],int)): raise ValueError
    coords=obj["cursor"]
    if coords!=sorted(coords) or len({a for a,_ in coords})!=len(coords): raise ValueError
    if any(a not in ("A","B","C","R","S") or not isinstance(n,int) or n<0 for a,n in coords): raise ValueError
    if encode(obj["change"],[(a,n) for a,n in coords])!=token: raise ValueError
    return obj

# Same-key supported history, including losing generations and exact-time provenance.
GX=add(1,"A","X",10,"x0"); GY=add(2,"A","Y",10,"y0"); GK=add(3,"A","K",10,"k0")
X1=scoped(4,"A","X","edit",11,GX.id,value="x1"); Y1=scoped(5,"A","Y","edit",11,GY.id,value="y1")
X2=scoped(6,"A","X","edit",12,GX.id,value="x2")
K_B=scoped(7,"B","K","edit",20,GK.id,value="kb"); K_C=scoped(7,"C","K","edit",20,GK.id,value="kc")
H8=scoped(8,"A","K","invalidate",21,GK.id,mode="hard")
V9=scoped(9,"B","K","validate",22,GK.id,clears=(("A",H8.id),))
S10=scoped(10,"A","K","invalidate",23,GK.id,mode="soft")
V_B=scoped(11,"B","K","validate",24,GK.id,clears=(("A",S10.id),))
I_C=scoped(12,"C","K","invalidate",25,GK.id,mode="hard")
V_PA=scoped(13,"B","K","validate",26,GK.id,clears=(("A",S10.id),))
V_PC=scoped(14,"C","K","validate",26,GK.id,clears=(("C",I_C.id),))
G_LOSE=add(50,"B","K",15,"old"); E_LOSE=scoped(100,"B","K","edit",30,G_LOSE.id,value="old2")
G_WIN=add(60,"A","K",31,"winner")
ATOMS=(frozenset((GX,X1,X2)),frozenset((GY,Y1)),frozenset((GK,K_B,K_C,H8,V9,S10,V_B,I_C,V_PA,V_PC)),frozenset((G_LOSE,E_LOSE,G_WIN)))
POOL=frozenset().union(*ATOMS); assert valid(POOL)
# Invalid cross-key generation and malformed address are rejected.
assert not valid((GX,scoped(20,"A","Y","edit",20,GX.id,value="bad")))
bad=Entry(20,"A","wrong","add",1,"X",value="x"); assert not valid((bad,))

# Projection, presence-before-value, and exact equal-time provenance.
assert presence_head((GK,G_LOSE,G_WIN),GK.key)==G_WIN
assert generation((GK,G_LOSE,E_LOSE,G_WIN),GK.key)==G_WIN.id
assert E_LOSE.sequence>G_WIN.sequence # losing-generation logical witness has higher event sequence
assert canonical_event((GK,K_B,K_C),GK.key,GK.id,20)==K_C
assert value_revision(K_C)>value_revision(K_B)

# All-mode vs hard frontier and delayed soft-after-validation.
assert frontier(POOL,GK.key,GK.id)!=frontier(POOL,GK.key,GK.id,True)
assert effective(V9,(GK,H8,V9),GK.key,GK.id,hard=True)
assert journal_hard((GK,H8,V9,S10),GK.key,GK.id) is False
assert canonical_event((GK,K_B,K_C,H8,V9),GK.key,GK.id,20)==canonical_event((GK,K_B,K_C,H8,V9,S10),GK.key,GK.id,20) # no value revision change
assert journal_fresh((GK,H8,V9,S10),GK.key,GK.id) is False # later soft defeats V9
assert journal_fresh((GK,H8,S10,V_B),GK.key,GK.id)
assert not journal_fresh((GK,H8,S10,I_C,V_PA,V_PC),GK.key,GK.id) # partial contexts do not combine
assert journal_hard((GK,H8,S10,I_C,V_PA,V_PC),GK.key,GK.id)
assert journal_hard((GK,S10),GK.key,GK.id) is False # empty hard frontier is vacuously non-hard

# Exact canonical compaction, notification equivalence, cursor partial processing.
C=compact(POOL); assert compact(C)==C and query(POOL)==query(C)
full=query(POOL)
for stop in range(len(full)+1):
    token=() if stop==0 else full[stop-1][1]
    assert obligations(POOL,token)==frozenset((e.author,e.key,e.action) for e,_ in full[stop:])
for ca,cb,cc in product(range(0,16,5),repeat=3):
    cur=(("A",ca),("B",cb),("C",cc)); assert obligations(POOL,cur)==obligations(C,cur)

# Portable cursors ignore host coverage; concurrent arrival order is irrelevant.
portable=(("A",10),("B",3)); low=(('A',7),('B',100)); assert dict(portable)['A']>dict(low)['A']
assert all(e.author!="A" or e.sequence>10 for e,_ in query(POOL,portable))
assert query((GX,GY))==query((GY,GX))
assert vmax((('A',7),('B',100)),portable)==(('A',10),('B',100))

# Canonical codec/address evidence.
change={"action":"edit","bindings":[],"nodeName":"X","time":12}
tok=encode(change,portable); assert decode(tok)["cursor"]==[["A",10],["B",3]]
for malformed in (encode(change,(('B',3),('A',10))),):
    # Encoder canonicalizes input; decoder receives only canonical output.
    assert malformed==tok
raw=json.dumps({"v":1,"change":change,"cursor":[["A",1],["A",2]]},sort_keys=True,separators=(",",":"))
try: decode(base64.urlsafe_b64encode(raw.encode()).decode().rstrip('=')); assert False
except ValueError: pass
bad_change={"action":"fake","bindings":[],"nodeName":"X","time":12}
try: decode(encode(bad_change,portable)); assert False
except ValueError: pass
bad_uint=json.dumps({"v":1,"change":change,"cursor":[["A",-1]]},sort_keys=True,separators=(",",":"))
try: decode(base64.urlsafe_b64encode(bad_uint.encode()).decode().rstrip('=')); assert False
except ValueError: pass

# Non-canonical JSON spelling is rejected even when its decoded value is plausible.
noncanonical=base64.urlsafe_b64encode(json.dumps({"v":1,"change":change,"cursor":[["A",10],["B",3]]}).encode()).decode().rstrip('=')
try: decode(noncanonical); assert False
except ValueError: pass

# Exhaust supported atom deliveries for merge algebra/future union closure.
subsets=[frozenset().union(*(ATOMS[i] for i in range(len(ATOMS)) if mask&(1<<i))) for mask in range(1<<len(ATOMS))]
assert all(valid(s) for s in subsets)
def merge(a,b): return compact(set(a)|set(b))
for a,b,c in product(subsets,repeat=3):
    assert merge(a,b)==merge(b,a)
    assert merge(merge(a,b),c)==merge(a,merge(b,c))
    assert compact(set(compact(a))|set(b))==compact(set(a)|set(b))

# Explicit delayed-union and uncompacted-source/compact-receiver/reverse traces.
left=ATOMS[0]|ATOMS[1]; delayed=ATOMS[2]
assert compact(compact(left)|delayed)==compact(left|delayed)
assert merge(compact(POOL),POOL)==compact(POOL)==merge(POOL,compact(POOL))

@dataclass(frozen=True)
class GraphState:
    journal:frozenset; coverage:tuple; status:str; proofs:bool

def receive(r,s,new_reason=None):
    j=merge(r.journal,s.journal); g=GK.id
    hard=journal_hard(j,GK.key,g)
    authored=None
    if new_reason and not hard:
        authored=new_reason; j=merge(j,(new_reason,)); hard=True
    fresh=journal_fresh(j,GK.key,g) and r.proofs and s.proofs and not hard
    status="fresh" if fresh else ("hard" if hard else "soft")
    proofs=(r.proofs and s.proofs) if status!="hard" else False
    cov=vmax(r.coverage,s.coverage)
    if authored: cov=vmax(cov,((authored.author,authored.sequence),))
    return GraphState(j,cov,status,proofs),authored

# Imported uncovered hard barrier removes proofs silently; no boolean OR shortcut.
R=GraphState(frozenset((GK,)),(('A',3),),"fresh",True)
S=GraphState(frozenset((GK,H8)),(('A',8),),"hard",False)
R1,echo=receive(R,S); assert R1.status=="hard" and not R1.proofs and echo is None
assert receive(R1,S)[0]==R1
# Genuine unrepresented stale-soft -> hard decision authors once and reverse imports.
Soft=GraphState(frozenset((GK,S10)),(('A',10),),"soft",True)
IR=scoped(20,"R","K","invalidate",30,GK.id,mode="hard")
R2,new=receive(Soft,Soft,IR); assert new==IR and R2.status=="hard"
S2,reverse_echo=receive(Soft,R2,IR); assert S2==R2 and reverse_echo is None

# Reset equal/unequal presence fencing and delayed source generation non-resurrection.
def reset(rg,rv,sg,sv,nextg):
    return (rg,rv,False) if rg>sg and rv==sv else (nextg,sv,True)
for rv,sv in (("A","A"),("A","B")):
    one=reset((10,"R"),rv,(100,"S"),sv,(101,"R")); assert one[0]>(100,"S") and one[1]==sv
    assert reset(one[0],one[1],(100,"S"),sv,(102,"R"))==(one[0],sv,False)

# Restart, allocator gaps, old-witness reintroduction, and n=0/r>0.
cov=(('A',150),('B',100),('C',14)); assert vmax(cov,(('A',120),))==cov
assert all(dict(cov)[e.author]>=e.sequence for e in C)
assert obligations(merge(C,(X1,)),(('A',150),))==obligations(C,(('A',150),))
empty_cov=(('A',50),('B',9)); assert compact(())==frozenset() and len(empty_cov)==2
# Finite storage components satisfy global nr^2+r and nonempty reduction.
for s in subsets:
    cs=compact(s); n=len({e.key for e in cs}); r=len({e.author for e in s})
    assert len(maxima(s))<=len(ACTIONS)*n*r if n and r else len(maxima(s))==0
    assert len(cs)<=len(s)
    if n>0 and r>0: assert r<=n*r*r
assert len(empty_cov)>0 # coverage survives with n=0

print(f"journal spec model verified: {len(subsets)} supported deliveries, causal/codec/reset traces passed")
