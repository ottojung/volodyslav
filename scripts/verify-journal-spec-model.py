#!/usr/bin/env python3
"""Executable bounded evidence for the one-journal IncrementalGraph specification."""
from dataclasses import dataclass
from itertools import product
from pathlib import Path
import base64, json, re

UINT64_MAX=2**64-1
TIMESTAMP_MIN=-8640000000000000; TIMESTAMP_MAX=8640000000000000
A="aaaaaaaaaaaaaaaa"; B="bbbbbbbbbbbbbbbb"; C="cccccccccccccccc"; R="rrrrrrrrrrrrrrrr"; S="ssssssssssssssss"
AUTHORS={A,B,C,R,S}; ACTIONS={"add","edit","delete","invalidate","validate"}
ROOT=Path(__file__).resolve().parent
KEY_VECTORS=json.loads((ROOT/"fixtures/node-key-serialization.json").read_text())
TIME_VECTORS=json.loads((ROOT/"fixtures/unix-timestamp-domain.json").read_text())

def address(index):
    v=KEY_VECTORS[index]
    return v["serialized"],v["nodeName"],tuple(json.loads(json.dumps(v["bindings"])))
KX,NX,BX=address(0); KY,NY,BY=address(1); KK,NK,BK=address(3)

def valid_uint64(n): return type(n) is int and 0<=n<=UINT64_MAX
def valid_timestamp(n): return type(n) is int and TIMESTAMP_MIN<=n<=TIMESTAMP_MAX
assert all(valid_timestamp(int(v["value"]))==v["valid"] for v in TIME_VECTORS)

def production_key(name,bindings):
    # Exact shared production fixture, not a substitute serializer.
    for v in KEY_VECTORS:
        if v["nodeName"]==name and v["bindings"]==list(bindings): return v["serialized"]
    raise ValueError("address is not a shared production vector")

@dataclass(frozen=True,order=True)
class Entry:
    sequence:int; author:str; key:str; time:int; node_name:str; bindings:tuple
    kind:str; public_action:str|None=None; generation:tuple|None=None
    initial_freshness:tuple|None=None; mode:str|None=None; clears:tuple=(); value:str|None=None
    @property
    def id(self): return (self.sequence,self.author)

def gen(seq,author,address_tuple,time,value,public_action,initial_id):
    key,name,bindings=address_tuple
    return Entry(seq,author,key,time,name,bindings,"generation",public_action,
                 initial_freshness=initial_id,value=value)
def event(seq,author,address_tuple,time,kind,generation,*,mode=None,clears=(),value=None):
    key,name,bindings=address_tuple
    return Entry(seq,author,key,time,name,bindings,kind,kind,generation,
                 mode=mode,clears=tuple(sorted(clears)),value=value)
def delete(seq,author,address_tuple,time):
    key,name,bindings=address_tuple
    return Entry(seq,author,key,time,name,bindings,"delete","delete")
def public_action(e): return e.public_action

def valid(entries,require_initial=True):
    es=tuple(entries); by_id={}
    for e in es:
        if e.id in by_id and by_id[e.id]!=e:return False
        by_id[e.id]=e
        if not valid_uint64(e.sequence) or e.sequence==0 or e.author not in AUTHORS:return False
        if not valid_timestamp(e.time):return False
        try:
            if e.key!=production_key(e.node_name,e.bindings):return False
        except ValueError:return False
        if e.kind=="generation":
            if e.public_action not in ("add","edit",None) or e.generation is not None:return False
            if e.initial_freshness is None or e.mode is not None or e.clears:return False
        elif e.kind=="delete":
            if e.public_action!="delete" or e.generation is not None or e.initial_freshness is not None:return False
        elif e.kind in ("edit","invalidate","validate"):
            if e.public_action!=e.kind or e.generation is None or e.initial_freshness is not None:return False
            if e.kind=="invalidate" and e.mode not in ("soft","hard"):return False
            if e.kind!="invalidate" and e.mode is not None:return False
            if e.kind!="validate" and e.clears:return False
        else:return False
    for e in es:
        if e.generation:
            g=by_id.get(e.generation)
            if not g or g.kind!="generation" or g.key!=e.key:return False
        if e.kind=="generation" and require_initial:
            f=by_id.get(e.initial_freshness)
            if (not f or f.kind not in ("validate","invalidate") or
                f.generation!=e.id or f.key!=e.key or f.id<=e.id):return False
        seen=set()
        for author,ref in e.clears:
            i=by_id.get(ref)
            if (author in seen or not i or i.kind!="invalidate" or i.author!=author or
                i.key!=e.key or i.generation!=e.generation or i.sequence>=e.sequence):return False
            seen.add(author)
    vals=[e for e in es if e.kind=="validate"]
    for v1 in vals:
        for v2 in vals:
            if (v1.author,v1.key,v1.generation)==(v2.author,v2.key,v2.generation) and v1.sequence<v2.sequence:
                d=dict(v2.clears)
                if any(a not in d or d[a][0]<r[0] for a,r in v1.clears):return False
    return True

def presence_head(es,key):
    xs=[e for e in es if e.key==key and e.kind in ("generation","delete")]
    return max(xs,key=lambda e:e.id) if xs else None
def generation(es,key):
    p=presence_head(es,key);return p.id if p and p.kind=="generation" else None
def value_heads(es,key,g):
    out={}
    for e in es:
        if (e.kind=="generation" and e.id==g) or (e.kind=="edit" and e.key==key and e.generation==g):
            if e.author not in out or out[e.author].sequence<e.sequence:out[e.author]=e
    return frozenset(out.values())
def canonical_event(es,key,g,time):return max((e for e in value_heads(es,key,g) if e.time==time),key=lambda e:e.id)
def revision(e):return(e.time,e.sequence,e.author)
def frontier(es,key,g,hard=False):
    out={}
    for e in es:
        if e.kind=="invalidate" and e.key==key and e.generation==g and (not hard or e.mode=="hard"):
            if e.author not in out or out[e.author].sequence<e.sequence:out[e.author]=e
    return frozenset(out.values())
def covers(v,i,es):
    c={e.id:e for e in es}.get(dict(v.clears).get(i.author))
    return bool(c and c.kind=="invalidate" and c.author==i.author and c.key==i.key and
                c.generation==i.generation and c.sequence>=i.sequence)
def effective(v,es,key,g,hard=False):return v.kind=="validate" and v.key==key and v.generation==g and all(covers(v,i,es) for i in frontier(es,key,g,hard))
def journal_fresh(es,key,g):return any(effective(v,es,key,g) for v in es if v.kind=="validate")
def journal_hard(es,key,g):
    hf=frontier(es,key,g,True)
    return bool(hf) and not any(effective(v,es,key,g,True) for v in es if v.kind=="validate")
def notification_maxima(es):
    out={}
    for e in es:
        a=public_action(e)
        if a is None:continue
        c=(e.author,e.key,a)
        if c not in out or out[c].sequence<e.sequence:out[c]=e
    return frozenset(out.values())
def compact(es):
    es=frozenset(es);assert valid(es);by_id={e.id:e for e in es};keep=set(notification_maxima(es))
    for key in {e.key for e in es}:
        p=presence_head(es,key)
        if p:keep.add(p)
        g=p.id if p and p.kind=="generation" else None
        if g:
            heads=value_heads(es,key,g);keep.update(heads)
            keep.update(frontier(es,key,g));keep.update(frontier(es,key,g,True))
            vals={}
            for e in es:
                if e.kind=="validate" and e.key==key and e.generation==g:
                    if e.author not in vals or vals[e.author].sequence<e.sequence:vals[e.author]=e
            keep.update(vals.values())
    changed=True
    while changed:
        changed=False
        for e in tuple(keep):
            refs=[]
            if e.generation:refs.append(e.generation)
            if e.kind=="generation":refs.append(e.initial_freshness)
            refs.extend(ref for _,ref in e.clears)
            for ref in refs:
                if by_id[ref] not in keep:keep.add(by_id[ref]);changed=True
    out=frozenset(keep);assert valid(out);return out
def query(es,cursor=()):
    v=dict(cursor);out=[]
    for e in sorted((e for e in notification_maxima(es) if e.sequence>v.get(e.author,0)),key=lambda e:e.id):
        v[e.author]=e.sequence
        out.append(({"nodeName":e.node_name,"bindings":list(e.bindings),"action":public_action(e),"time":e.time},tuple(sorted(v.items()))))
    return tuple(out)
def vmax(a,b):
    d=dict(a)
    for k,v in b:d[k]=max(d.get(k,0),v)
    return tuple(sorted(d.items()))

# First pull and migration-created fresh/soft-stale/hard-stale materialization fixtures.
GX=gen(1,A,(KX,NX,BX),10,"x", "add",(2,A)); VX=event(2,A,(KX,NX,BX),11,"validate",GX.id)
GY=gen(3,A,(KY,NY,BY),10,"y","add",(4,A)); SY=event(4,A,(KY,NY,BY),11,"invalidate",GY.id,mode="soft")
GK=gen(5,A,(KK,NK,BK),10,"k","add",(6,A)); HK=event(6,A,(KK,NK,BK),11,"invalidate",GK.id,mode="hard")
assert valid((GX,VX,GY,SY,GK,HK))
assert not valid((GX,)) # positive generation without explicit initial freshness rejected
assert journal_fresh((GX,VX),KX,GX.id) and not journal_hard((GX,VX),KX,GX.id)
assert not journal_fresh((GY,SY),KY,GY.id) and not journal_hard((GY,SY),KY,GY.id)
assert journal_hard((GK,HK),KK,GK.id)
# The same three pairs are migration fresh/soft-stale/hard-stale creation traces.
assert {c["action"] for c,_ in query((GX,VX))}=={"add","validate"}
assert {c["action"] for c,_ in query((GY,SY))}=={"add","invalidate"}
assert {c["action"] for c,_ in query((GK,HK))}=={"add","invalidate"}

# Hard clear then later soft; delayed soft does not change value revision.
V7=event(7,B,(KK,NK,BK),12,"validate",GK.id,clears=((A,HK.id),))
S8=event(8,A,(KK,NK,BK),13,"invalidate",GK.id,mode="soft")
assert journal_fresh((GK,HK,V7),KK,GK.id) and not journal_hard((GK,HK,V7),KK,GK.id)
assert not journal_fresh((GK,HK,V7,S8),KK,GK.id) and not journal_hard((GK,HK,V7,S8),KK,GK.id)
assert canonical_event((GK,HK,V7),KK,GK.id,10)==canonical_event((GK,HK,V7,S8),KK,GK.id,10)
IC=event(9,C,(KK,NK,BK),14,"invalidate",GK.id,mode="hard")
VPB=event(10,B,(KK,NK,BK),15,"validate",GK.id,clears=((A,S8.id),))
VPC=event(11,C,(KK,NK,BK),15,"validate",GK.id,clears=((C,IC.id),))
assert not journal_fresh((GK,HK,S8,IC,VPB,VPC),KK,GK.id)
assert journal_hard((GK,HK,S8,IC,VPB,VPC),KK,GK.id) # partial contexts do not combine

# Presence and identifier incarnations: G1, delete, G2 is valid and polling is key-addressed.
D12=delete(12,A,(KX,NX,BX),16)
GX2=gen(13,A,(KX,NX,BX),17,"x2","add",(14,A)); VX2=event(14,A,(KX,NX,BX),18,"validate",GX2.id)
assert valid((GX,VX,D12,GX2,VX2)) and presence_head((GX,VX,D12,GX2,VX2),KX)==GX2
@dataclass(frozen=True)
class IdentifierState:
    current:tuple; retired:tuple; next_number:int
def materialize(ids,key):
    ident=f"node-{ids.next_number}";return IdentifierState(ids.current+((ident,key),),ids.retired,ids.next_number+1),ident
def remove(ids,ident):
    return IdentifierState(tuple(x for x in ids.current if x[0]!=ident),ids.retired+(ident,),ids.next_number)
ids,x1=materialize(IdentifierState((),(),1),KX);ids=remove(ids,x1);ids,x2=materialize(ids,KX)
assert x1!=x2 and x1 in ids.retired and all(i!=x1 for i,_ in ids.current)
assert all(set(change)=={"nodeName","bindings","action","time"} for change,_ in query((GX,VX,D12,GX2,VX2)))

# Reset generation forms: equal dominated silent; equal fence null; unequal edit; absent add.
def reset_generation(receiver_g,rv,source_g,sv,next_seq,fresh_kind="validate",receiver_identifier="node-r"):
    # A surviving reset returns the same receiver identifier; polling never carries it.
    if receiver_g and receiver_g.id>source_g.id and rv==sv:return (),receiver_g,receiver_identifier
    action=None if receiver_g and rv==sv else ("edit" if receiver_g else "add")
    fid=(next_seq+1,R);g=gen(next_seq,R,(KK,NK,BK),source_g.time,sv,action,fid)
    f=event(next_seq+1,R,(KK,NK,BK),source_g.time,fresh_kind,g.id,mode=("soft" if fresh_kind=="invalidate" else None))
    return (g,f),g,receiver_identifier
GS=gen(100,S,(KK,NK,BK),20,"A","add",(101,S));VS=event(101,S,(KK,NK,BK),21,"validate",GS.id)
GR=gen(10,R,(KK,NK,BK),20,"A","add",(11,R));VR=event(11,R,(KK,NK,BK),21,"validate",GR.id)
fenced,GR2,reset_id=reset_generation(GR,"A",GS,"A",102);assert GR2.id>GS.id and GR2.public_action is None
assert {c["action"] for c,_ in query(fenced)}=={"validate"}
assert reset_id=="node-r" and reset_generation(GR2,"A",GS,"A",104)[0]==()
edited,GE,edited_id=reset_generation(GR,"A",GS,"B",106);assert GE.public_action=="edit" and "add" not in {c["action"] for c,_ in query(edited)}
created,GA,created_id=reset_generation(None,None,GS,"A",108,receiver_identifier="node-new");assert edited_id==reset_id and {c["action"] for c,_ in query(created)}=={"add","validate"} and created_id!=x1
assert presence_head((*fenced,GS,VS),KK)==GR2 # delayed old source cannot undo fence

# Losing generation carries a higher-sequence logical witness than the winning presence generation.
GL=gen(30,C,(KY,NY,BY),20,"losing","edit",(31,C));VL=event(31,C,(KY,NY,BY),21,"validate",GL.id)
EL90=event(90,C,(KY,NY,BY),22,"edit",GL.id,value="losing-late")
GW=gen(40,B,(KY,NY,BY),23,"winner","edit",(41,B));VW=event(41,B,(KY,NY,BY),24,"validate",GW.id)
assert valid((GL,VL,EL90,GW,VW)) and presence_head((GL,VL,EL90,GW,VW),KY)==GW and EL90.sequence>GW.sequence

# Canonical compaction includes null fence and polling remains exact.
POOL=frozenset((GX,VX,D12,GX2,VX2,GY,SY,GK,HK,V7,S8,IC,VPB,VPC,*fenced,*edited,GL,VL,EL90,GW,VW))
assert valid(POOL);CP=compact(POOL);assert GR2 in compact(fenced) and compact(CP)==CP and query(POOL)==query(CP)
# Atom groups keep structural references valid for exhaustive algebra.
ATOMS=(frozenset((GX,VX,D12,GX2,VX2)),frozenset((GY,SY)),frozenset((GK,HK,V7,S8,IC,VPB,VPC)),frozenset((*fenced,*edited)),frozenset((GL,VL,EL90)),frozenset((GW,VW)))
subsets=[frozenset().union(*(ATOMS[i] for i in range(len(ATOMS)) if mask&(1<<i))) for mask in range(1<<len(ATOMS))]
def merge(a,b):return compact(set(a)|set(b))
for a,b,c in product(subsets[::4],repeat=3):
    assert valid(a) and merge(a,b)==merge(b,a)
    assert merge(merge(a,b),c)==merge(a,merge(b,c))
    assert compact(set(compact(a))|set(b))==compact(set(a)|set(b))

# Delayed winning generation agrees whether losing high witness was compacted first.
assert compact(compact((GL,VL,EL90))|frozenset((GW,VW)))==compact((GL,VL,EL90,GW,VW))

# Cursor partial processing, arrival order, and portability.
full=query(POOL)
for stop in range(len(full)+1):
    token=() if stop==0 else full[stop-1][1]
    resumed=query(POOL,token)
    assert [x[0] for x in resumed]==[x[0] for x in full[stop:]]
portable=((A,10),(B,3));assert query((GX,VX,GY,SY))==query((GY,SY,GX,VX))
assert dict(portable)[A]>dict(((A,7),(B,100)))[A]

# Canonical token domain.
def encode(change,cursor):
    raw=json.dumps({"change":change,"cursor":[list(x) for x in sorted(cursor)],"v":1},sort_keys=True,separators=(",",":"),ensure_ascii=True)
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
def decode(token):
    raw=base64.urlsafe_b64decode(token+"="*((-len(token))%4)).decode();o=json.loads(raw)
    if set(o)!={"change","cursor","v"} or o["v"]!=1:raise ValueError
    ch=o["change"]
    if (type(ch) is not dict or set(ch)!={"nodeName","bindings","action","time"} or
        type(ch["nodeName"]) is not str or type(ch["bindings"]) is not list or ch["action"] not in ACTIONS or
        not valid_timestamp(ch["time"])):raise ValueError
    production_key(ch["nodeName"],tuple(ch["bindings"]))
    coords=o["cursor"]
    if coords!=sorted(coords) or len({a for a,_ in coords})!=len(coords):raise ValueError
    if any(type(a) is not str or not re.fullmatch("[a-z]{16}",a) or not valid_uint64(n) for a,n in coords):raise ValueError
    if encode(ch,[tuple(x) for x in coords])!=token:raise ValueError
    return o
change=full[0][0];tok=encode(change,portable);assert decode(tok)["cursor"]==[list(x) for x in portable]
def expect_bad_obj(o):
    raw=json.dumps(o,sort_keys=True,separators=(",",":"));t=base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    try:decode(t);assert False
    except (ValueError,TypeError,KeyError):pass
base={"change":change,"cursor":[[A,1]],"v":1}
for bad in (
    {**base,"cursor":[[A,True]]},{**base,"cursor":[[A,False]]},{**base,"cursor":[[A,-1]]},
    {**base,"cursor":[[A,2**64]]},{**base,"cursor":[[A,2**80]]},{**base,"cursor":[["bad",1]]},{**base,"cursor":[[A.upper(),1]]},
    {**base,"cursor":[[A,1],[A,2]]},{**base,"cursor":[[B,1],[A,2]]},
    {**base,"v":2},{**base,"extra":1},{**base,"change":{**change,"action":"fake"}},
    {**base,"change":{**change,"time":True}},{**base,"change":{**change,"time":TIMESTAMP_MAX+1}},{**base,"change":{**change,"nodeName":"not-a-vector"}},{**base,"change":{**change,"bindings":{}}},{**base,"change":{"action":"add"}},
):expect_bad_obj(bad)
# Noncanonical whitespace.
raw=json.dumps(base);expect=base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
try:decode(expect);assert False
except ValueError:pass

@dataclass(frozen=True)
class Host:
    fingerprint:str; clock:int; coverage:tuple; journal:frozenset; status:str; proofs:bool
def receive(r,s):
    j=merge(r.journal,s.journal);cov=vmax(r.coverage,s.coverage)
    # Import alone: clock unchanged. Applicable hard authority is derived from journal.
    g=generation(j,KK);hard=bool(g and journal_hard(j,KK,g))
    return Host(r.fingerprint,r.clock,cov,j,"hard" if hard else r.status,False if hard else r.proofs)
def author_invalidate(h,address_tuple,g,mode):
    observed=max([e.sequence for e in h.journal]+list(dict(h.coverage).values())+[h.clock])
    seq=observed+1;e=event(seq,h.fingerprint,address_tuple,30,"invalidate",g,mode=mode)
    j=merge(h.journal,(e,));cov=vmax(h.coverage,((h.fingerprint,seq),))
    return Host(h.fingerprint,seq,cov,j,"hard" if mode=="hard" else "soft",mode!="hard"),e
# A100/B1 lazy-clock reverse catch-up.
GA100=gen(99,A,(KK,NK,BK),10,"a","add",(100,A));VA100=event(100,A,(KK,NK,BK),11,"validate",GA100.id)
DB1=delete(1,B,(KX,NX,BX),10)
HA=Host(A,100,((A,100),),frozenset((GA100,VA100)),"fresh",True)
HB=Host(B,1,((B,1),),frozenset((DB1,)),"soft",False)
A1=receive(HA,HB);B1=receive(HB,A1)
assert A1.journal==B1.journal and A1.coverage==B1.coverage and B1.clock==1
B2,BI=author_invalidate(B1,(KK,NK,BK),GA100.id,"hard");assert BI.sequence==101 and B2.clock==dict(B2.coverage)[B]
# Imported hard barrier enforces without echo; reverse imports genuine local hardening.
receiver=Host(R,11,((R,11),),frozenset((GR,VR)),"fresh",True)
source=Host(S,102,((S,102),),frozenset((GS,VS,event(102,S,(KK,NK,BK),22,"invalidate",GS.id,mode="hard"))),"hard",False)
# Different generations: carrier import itself still authors nothing and local clock stays.
received=receive(receiver,source);assert received.clock==receiver.clock and received.status=="hard" and len(received.journal)==len(merge(receiver.journal,source.journal))
hard_host,IR=author_invalidate(receiver,(KK,NK,BK),GR.id,"hard")
reverse=receive(source,hard_host);assert IR in reverse.journal and reverse.clock==source.clock

# Empty journal/nonempty coverage storage boundary.
assert compact(())==frozenset() and len(((A,100),(B,2)))==2
for subset in subsets:
    cs=compact(subset);n=len({e.key for e in cs});r=len({e.author for e in subset})
    assert len(cs)<=len(subset)
    if n and r:assert r<=n*r*r

print("journal spec model verified: generation/freshness/identifier/reset/allocator/codec traces passed")
