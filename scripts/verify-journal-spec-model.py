#!/usr/bin/env python3
"""Bounded semantic transition model for the IncrementalGraph journal specification."""
from dataclasses import dataclass, replace
from itertools import product
from pathlib import Path
import base64,json,math,re as regex
U64=2**64-1;TMIN=-8640000000000000;TMAX=8640000000000000
A="aaaaaaaaaaaaaaaa";B="bbbbbbbbbbbbbbbb";C="cccccccccccccccc";R="rrrrrrrrrrrrrrrr";S="ssssssssssssssss"
AUTH={A,B,C,R,S};ACT={"add","edit","delete","invalidate","validate"};ROOT=Path(__file__).parent
KV=json.loads((ROOT/"fixtures/node-key-serialization.json").read_text());TV=json.loads((ROOT/"fixtures/unix-timestamp-domain.json").read_text())
def addr(i):v=KV[i];return(v["serialized"],v["nodeName"],tuple(v["bindings"]))
K,N,BS=addr(3);KI,NI,BI=addr(0);KD,ND,BD=addr(1);KE,NE,BE=addr(2)
SCHEMA={K:(),KI:(),KD:(),KE:(KI,KD,KI)}
def is_equal(a,b):
 # Exact executable form of DEF-EQUAL-01, including JavaScript number and key-order semantics.
 if isinstance(a,bool)or isinstance(b,bool):return type(a) is bool and type(b) is bool and a==b
 if isinstance(a,(int,float))and isinstance(b,(int,float)):
  return (math.isnan(a)and math.isnan(b))if isinstance(a,float)and isinstance(b,float)else a==b
 if type(a) is not type(b):return False
 if isinstance(a,str):return a==b
 if isinstance(a,(list,tuple)):return len(a)==len(b)and all(is_equal(x,y)for x,y in zip(a,b))
 if isinstance(a,dict):return list(a.keys())==list(b.keys())and all(is_equal(a[k],b[k])for k in a)
 return False
nan=float("nan")
assert is_equal(nan,nan) and is_equal([{"n":nan}],[{"n":nan}])
assert is_equal({"a":1,"b":[2]}, {"a":1.0,"b":[2.0]})
assert not is_equal({"a":1,"b":2}, {"b":2,"a":1})
assert is_equal([1,{"x":[nan]}],[1.0,{"x":[nan]}]) and not is_equal(True,1)
def prodkey(n,b):
 for v in KV:
  if v["nodeName"]==n and v["bindings"]==list(b):return v["serialized"]
 raise ValueError
def uint(n):return type(n) is int and 0<=n<=U64
def timestamp(n):return type(n) is int and TMIN<=n<=TMAX
assert all(timestamp(int(v["value"]))==v["valid"] for v in TV)
@dataclass(frozen=True,order=True)
class E:
 sequence:int;author:str;key:str;time:int;name:str;bindings:tuple;kind:str
 generation:tuple|None=None;initial:tuple|None=None;mode:str|None=None;clears:tuple=();value:str|None=None
 @property
 def id(self):return(self.sequence,self.author)
def gen(q,a,address,t,val,initial):k,n,b=address;return E(q,a,k,t,n,b,"add",initial=initial,value=val)
def ev(q,a,address,t,kind,g,mode=None,clears=(),value=None):k,n,b=address;return E(q,a,k,t,n,b,kind,g,mode=mode,clears=tuple(sorted(clears)),value=value)
def dele(q,a,address,t):k,n,b=address;return E(q,a,k,t,n,b,"delete")
def valid(es):
 es=tuple(es);d={}
 for e in es:
  if e.id in d and d[e.id]!=e:return False
  d[e.id]=e
  if e.author not in AUTH or not uint(e.sequence) or e.sequence==0 or not timestamp(e.time):return False
  try:
   if e.key!=prodkey(e.name,e.bindings):return False
  except ValueError:return False
  if e.kind=="add":
   if e.generation or not e.initial or e.mode or e.clears:return False
  elif e.kind=="delete":
   if e.generation or e.initial or e.mode or e.clears:return False
  elif e.kind in ("edit","invalidate","validate"):
   if not e.generation or e.initial:return False
   if e.kind=="invalidate" and e.mode not in ("soft","hard"):return False
   if e.kind!="invalidate" and e.mode:return False
   if e.kind!="validate" and e.clears:return False
   if tuple(sorted(e.clears))!=e.clears or len({a for a,_ in e.clears})!=len(e.clears) or any(a not in AUTH or not uint(q) for a,q in e.clears):return False
  else:return False
 for e in es:
  if e.generation:
   g=d.get(e.generation)
   if not g or g.kind!="add" or g.key!=e.key:return False
  if e.kind=="add":
   f=d.get(e.initial)
   if not f or f.kind not in ("validate","invalidate") or f.generation!=e.id or f.id<=e.id:return False
 vals=[e for e in es if e.kind=="validate"]
 for v1 in vals:
  for v2 in vals:
   if (v1.author,v1.key,v1.generation)==(v2.author,v2.key,v2.generation) and v1.sequence<v2.sequence:
    later=dict(v2.clears)
    if any(later.get(a,0)<q for a,q in v1.clears):return False
 return True
def ph(es,k):
 x=[e for e in es if e.key==k and e.kind in ("add","delete")];return max(x,key=lambda e:e.id) if x else None
def generation(es,k):p=ph(es,k);return p.id if p and p.kind=="add" else None
def vheads(es,k,g):
 o={}
 for e in es:
  if (e.kind=="add" and e.id==g) or(e.kind=="edit" and e.key==k and e.generation==g):
   if e.author not in o or o[e.author].sequence<e.sequence:o[e.author]=e
 return frozenset(o.values())
def origin(es,k,g,t):return max((e for e in vheads(es,k,g) if e.time==t),key=lambda e:e.id)
def front(es,k,g,hard=False):
 o={}
 for e in es:
  if e.kind=="invalidate" and e.key==k and e.generation==g and(not hard or e.mode=="hard"):
   if e.author not in o or o[e.author].sequence<e.sequence:o[e.author]=e
 return frozenset(o.values())
def covers(v,i):return v.kind=="validate" and v.key==i.key and v.generation==i.generation and i.sequence<=dict(v.clears).get(i.author,0)
def eff(v,es,k,g,hard=False):return v.key==k and v.generation==g and all(covers(v,i) for i in front(es,k,g,hard))
def fresh(es,k,g):return any(eff(v,es,k,g) for v in es if v.kind=="validate")
def hard(es,k,g):
 f=front(es,k,g,True);return bool(f)and not any(eff(v,es,k,g,True) for v in es if v.kind=="validate")
def nmax(es):
 o={}
 for e in es:
  c=(e.author,e.key,e.kind)
  if c not in o or o[c].sequence<e.sequence:o[c]=e
 return frozenset(o.values())
def compact(es):
 es=frozenset(es);assert valid(es);by={e.id:e for e in es};keep=set(nmax(es))
 for k in {e.key for e in es}:
  p=ph(es,k)
  if p:keep.add(p)
  g=p.id if p and p.kind=="add" else None
  if not g:continue
  keep.update(vheads(es,k,g))
  vals={}
  for v in es:
   if v.kind=="validate" and v.key==k and v.generation==g:
    if v.author not in vals or vals[v.author].sequence<v.sequence:vals[v.author]=v
  keep.update(vals.values())
  for i in front(es,k,g):
   if not any(covers(v,i) for v in vals.values()):keep.add(i)
  for i in front(es,k,g,True):
   if not any(covers(v,i) for v in vals.values()):keep.add(i)
 changed=True
 while changed:
  changed=False
  for e in tuple(keep):
   refs=([e.generation]if e.generation else[])+([e.initial]if e.kind=="add"else[])
   for x in refs:
    if by[x]not in keep:keep.add(by[x]);changed=True
 out=frozenset(keep);assert valid(out);return out
def merge(a,b):return compact(set(a)|set(b))
def vmax(a,b):
 d=dict(a)
 for x,q in b:d[x]=max(d.get(x,0),q)
 return tuple(sorted(d.items()))
def query(es,cursor=()):
 d=dict(cursor);out=[]
 for e in sorted((e for e in nmax(es)if e.sequence>d.get(e.author,0)),key=lambda e:e.id):
  d[e.author]=e.sequence;out.append((e.kind,tuple(sorted(d.items()))))
 return tuple(out)
@dataclass(frozen=True)
class M:
 identifier:str;generation:tuple;value:str;origin:tuple;modified:int;state:str;proof:bool;inputs:tuple=()
@dataclass(frozen=True)
class Rep:
 fp:str;clock:int;coverage:tuple;journal:frozenset;nodes:tuple;nextid:int=1;retired:tuple=()

def node(r,k):return dict(r.nodes).get(k)
def sem(r):return tuple(sorted((k,m.value,m.state,m.proof,m.inputs)for k,m in r.nodes))
def alloc(r,count=1,observed=0):
 top=max([observed,r.clock]+[e.sequence for e in r.journal]+list(dict(r.coverage).values()));return list(range(top+1,top+count+1))
def observed_watermark(r,s):
 return max([r.clock,s.clock]+[e.sequence for e in r.journal|s.journal]+list(dict(r.coverage).values())+list(dict(s.coverage).values()))
def carry_prefix(j,author,key,g,new=()):
 d=dict(new)
 prior=[v for v in j if v.kind=="validate"and v.author==author and v.key==key and v.generation==g]
 if prior:
  for a,q in max(prior,key=lambda v:v.sequence).clears:d[a]=max(d.get(a,0),q)
 return tuple(sorted(d.items()))
def add_events(r,events):
 j=merge(r.journal,events);q=max(e.sequence for e in events);return replace(r,clock=q,coverage=vmax(r.coverage,((r.fp,q),)),journal=j)
def classify(j,k,g):return"hard"if hard(j,k,g)else("fresh"if fresh(j,k,g)else"soft")
def choose_value(j,k,candidates):
 p=ph(j,k)
 if not p or p.kind=="delete":return None
 g=p.id;usable=[m for m in candidates if m and m.value is not None and m.generation==g]
 if not usable:return None
 # Value selection follows journal event time; equal semantic values permit proof transport.
 best=max(usable,key=lambda m:(m.modified,m.origin[0],m.origin[1]))
 return g,best

def validate_replica(r):
 if not valid(r.journal):return False
 cov=dict(r.coverage)
 if cov.get(r.fp,0)!=r.clock or any(cov.get(e.author,0)<e.sequence for e in r.journal):return False
 nd=dict(r.nodes)
 live=[m.identifier for _,m in r.nodes]
 if len(set(live))!=len(live) or set(live)&set(r.retired):return False
 for k,m in r.nodes:
  if k not in SCHEMA or generation(r.journal,k)!=m.generation:return False
  candidates=[e for e in r.journal if ((e.kind=="add"and e.id==m.origin)or(e.kind=="edit"and e.id==m.origin)) and e.key==k and ((e.kind=="add"and e.id==m.generation)or e.generation==m.generation)]
  try:canonical=origin(r.journal,k,m.generation,m.modified)
  except (ValueError,KeyError):return False
  if not candidates or canonical.id!=m.origin or candidates[0].time!=m.modified or not is_equal(candidates[0].value,m.value):return False
  if classify(r.journal,k,m.generation)!=m.state:return False
  deps=tuple(dict.fromkeys(SCHEMA[k]))
  if any(d not in nd for d in deps):return False
  if m.state=="hard"and m.proof:return False
  if m.state=="soft"and (not deps or not m.proof):return False
  if m.state=="fresh"and deps and not m.proof:return False
  if m.proof and deps:
   evidence=dict(m.inputs)
   if set(evidence)!=set(deps) or any(not is_equal(evidence[d],nd[d].value)for d in deps):return False
 return all((ph(r.journal,k)and ph(r.journal,k).kind=="delete")or k in nd for k in {e.key for e in r.journal if e.kind in("add","delete")})

def receive(r,s):
 if not validate_replica(r)or not validate_replica(s):raise ValueError("unsupported replica")
 j=merge(r.journal,s.journal);cov=vmax(r.coverage,s.coverage);nodes={};authored=[]
 order=[KI,KD,K,KE]
 for k in order:
  if k not in set(dict(r.nodes))|set(dict(s.nodes))|{e.key for e in j}:continue
  selected=choose_value(j,k,[node(r,k),node(s,k)])
  if not selected:continue
  g,best=selected;deps=tuple(dict.fromkeys(SCHEMA[k]));final_inputs={d:nodes[d].value for d in deps}
  if not deps:proof=True
  else:
   proof=False
   for source in (r,s):
    m=node(source,k)
    if not m or not m.proof or not is_equal(m.value,best.value):continue
    evidence=dict(m.inputs)
    if set(evidence)==set(deps)and all(is_equal(evidence[d],final_inputs[d])for d in deps):proof=True
  st=classify(j,k,g)
  if st=="hard":proof=False
  if not proof and st in ("fresh","soft"):
   q=alloc(replace(r,journal=j,coverage=cov),1)[0];h=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),max(best.modified,1),"invalidate",g,"hard");authored.append(h);j=merge(j,(h,));cov=vmax(cov,((r.fp,q),));st="hard"
  nodes[k]=M(best.identifier,g,best.value,best.origin,best.modified,st,proof,tuple(sorted(final_inputs.items()))if proof and deps else())
 out=Rep(r.fp,max([r.clock]+[e.sequence for e in authored]),cov,j,tuple(sorted(nodes.items())),r.nextid,r.retired)
 if not validate_replica(out):raise AssertionError("receive produced unsupported replica")
 return out,tuple(authored)
def best_key_name(k):
 for v in KV:
  if v["serialized"]==k:return v["nodeName"]
 raise KeyError
def best_key_bindings(k):
 for v in KV:
  if v["serialized"]==k:return tuple(v["bindings"])
 raise KeyError

def validation_absorbing(es,k,g,closed):
 return any(v.kind=="validate"and v.key==k and v.generation==g and all(dict(v.clears).get(a,0)>=q for a,q in closed)for v in es)
def reset_closed(r,s,k,g,target):
 # Source coverage fences compacted source invalidates; receiver validation vectors
 # carry earlier reset knowledge without chasing receiver coverage advanced by the
 # stabilizing validation itself.
 d=dict(s.coverage)
 for e in r.journal|s.journal:
  if e.kind=="invalidate"and e.key==k and e.generation==g and (target=="fresh"or e.mode=="hard"):d[e.author]=max(d.get(e.author,0),e.sequence)
  if e.kind=="validate"and e.key==k and e.generation==g:
   for a,q in e.clears:d[a]=max(d.get(a,0),q)
 return tuple(sorted(d.items()))
def reset(r,s,tau):
 if not validate_replica(r)or not validate_replica(s):raise ValueError("unsupported replica")
 if any(m.modified>tau for _,m in s.nodes):raise ValueError("unsupported clock")
 nodes={};events=[];work=r;watermark=observed_watermark(r,s);nextid=r.nextid
 for k in [KI,KD,K,KE]:
  sm=node(s,k)
  if not sm:continue
  rm=node(r,k);target=sm.state;deps=tuple(dict.fromkeys(SCHEMA[k]));final_inputs={d:nodes[d].value for d in deps}
  proof=True if not deps else sm.proof and set(dict(sm.inputs))==set(deps)and all(is_equal(dict(sm.inputs)[d],final_inputs[d])for d in deps)
  if target=="hard":proof=False
  if rm is None:
   q1,q2=alloc(work,2,watermark);g=gen(q1,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,sm.value,(q2,r.fp));fkind="validate"if target=="fresh"else"invalidate";mode=None if target=="fresh"else target.replace("stale-","");clears=carry_prefix(work.journal,r.fp,k,g.id,vmax(r.coverage,s.coverage))if fkind=="validate"else();f=ev(q2,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,fkind,g.id,mode,clears);events.extend((g,f));work=add_events(work,(g,f));m=M(f"{r.fp}-{nextid}",g.id,sm.value,g.id,tau,target,proof,tuple(sorted(final_inputs.items()))if proof and deps else());nextid+=1
  else:
   m=replace(rm,value=sm.value,proof=proof,state=target,inputs=tuple(sorted(final_inputs.items()))if proof and deps else())
   if not is_equal(rm.value,sm.value):
    q=alloc(work,1,watermark)[0];e=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"edit",rm.generation,value=sm.value);events.append(e);work=add_events(work,(e,));m=replace(m,origin=e.id,modified=tau)
   g=m.generation;retained=set(work.journal);closed=reset_closed(r,s,k,g,target)
   if target=="fresh"and not validation_absorbing(retained,k,g,closed):
    q=alloc(work,1,watermark)[0];c=carry_prefix(work.journal,r.fp,k,g,closed);v=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"validate",g,clears=c);events.append(v);work=add_events(work,(v,))
   elif target=="soft":
    absorbed=validation_absorbing(retained,k,g,closed)
    retained_soft=absorbed and classify(retained,k,g)=="soft"
    if not retained_soft:
     new=[]
     if not absorbed:
      q=alloc(work,1,watermark)[0];c=carry_prefix(work.journal,r.fp,k,g,closed);v=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"validate",g,clears=c);new.append(v);work=add_events(work,(v,))
     q=alloc(work,1,watermark)[0];i=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"invalidate",g,"soft");new.append(i);work=add_events(work,(i,));events.extend(new)
   elif target=="hard"and not hard(set(work.journal)|set(events),k,g):
    q=alloc(work,1,watermark)[0];i=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"invalidate",g,"hard");events.append(i);work=add_events(work,(i,))
  nodes[k]=m
 retired=list(r.retired)
 for k,rm in r.nodes:
  if node(s,k)is None:
   q=alloc(work,1,watermark)[0];d=dele(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau);events.append(d);work=add_events(work,(d,));retired.append(rm.identifier)
 out=replace(work,nodes=tuple(sorted(nodes.items())),nextid=nextid,retired=tuple(retired))
 if not validate_replica(out):raise AssertionError("reset produced unsupported replica")
 return out,tuple(events)

# Common generation and independent fresh histories expose naive fresh+fresh -> hard.
G=gen(1,A,(K,N,BS),1,"d",(2,A));V0=ev(2,A,(K,N,BS),2,"validate",G.id,clears=())
IR=ev(10,R,(K,N,BS),10,"invalidate",G.id,"hard");VR=ev(11,R,(K,N,BS),11,"validate",G.id,clears=((R,10),))
IS=ev(20,S,(K,N,BS),20,"invalidate",G.id,"hard");VS=ev(21,S,(K,N,BS),21,"validate",G.id,clears=((S,20),))
JR=frozenset((G,V0,IR,VR));JS=frozenset((G,V0,IS,VS));assert valid(JR)and valid(JS)
assert fresh(JR,K,G.id)and fresh(JS,K,G.id)
JU=merge(JR,JS);assert hard(JU,K,G.id)and not fresh(JU,K,G.id)
mR=M("r-id",G.id,"d",G.id,1,"fresh",True,((KI,"a"),));mS=M("s-id",G.id,"d",G.id,1,"fresh",True,((KI,"a"),))
RR=Rep(R,11,((A,2),(R,11)),JR,((K,mR),));SS=Rep(S,21,((A,2),(S,21)),JS,((K,mS),))
R1,re=reset(RR,SS,30);assert re and any(e.kind=="validate"and dict(e.clears).get(S)>=21 and dict(e.clears).get(R)>=10 for e in re)
R2,auth=receive(R1,SS);assert sem(R2)==sem(R1)and not auth and node(R2,K).state=="fresh"
# Reset idempotence is fully silent.
R1b,re2=reset(R1,SS,30);assert not re2 and R1b==R1
# Reset observes source S100 for allocation/causality without installing S coverage.
SS100=replace(SS,clock=100,coverage=((A,2),(S,100)))
RW,rwe=reset(RR,SS100,30);assert rwe and min(e.sequence for e in rwe)>100
assert dict(RW.coverage)[R]==RW.clock and S not in dict(RW.coverage) and dict(rwe[0].clears).get(S)==100

# A source-only validation is evidence, never installed authority. Receiver stabilization
# covers the whole consumed source prefix, survives delayed compacted evidence, and is idempotent.
plainR=Rep(R,0,((A,2),),frozenset((G,V0)),((K,mR),))
SV101=ev(101,S,(K,N,BS),20,"validate",G.id,clears=((S,100),))
sourceFresh=Rep(S,101,((A,2),(S,101)),frozenset((G,V0,SV101)),((K,mS),))
freshLocal,fle=reset(plainR,sourceFresh,30);assert len(fle)==1 and fle[0].kind=="validate"and fle[0].author==R
assert SV101 not in freshLocal.journal and dict(fle[0].clears)[S]>=101
delayed90=ev(90,S,(K,N,BS),19,"invalidate",G.id,"hard")
assert fresh(set(freshLocal.journal)|{delayed90},K,G.id)
freshAgain,fl2=reset(freshLocal,sourceFresh,30);assert not fl2 and freshAgain==freshLocal
rootSoftI=ev(102,R,(K,N,BS),31,"invalidate",G.id,"soft")
unsupportedRootSoft=Rep(R,102,((A,2),(R,102)),frozenset((G,V0,rootSoftI)),((K,replace(mR,state="soft",proof=True)),))
assert not validate_replica(unsupportedRootSoft)

# Later same-author validation carries reset-learned S100; regression is rejected.
V1=ev(101,R,(K,N,BS),31,"validate",G.id,clears=((S,100),))
IL=ev(102,R,(K,N,BS),32,"invalidate",G.id,"soft")
V2=ev(103,R,(K,N,BS),33,"validate",G.id,clears=carry_prefix(frozenset((G,V0,V1,IL)),R,K,G.id,((R,102),)))
MONO=frozenset((G,V0,V1,IL,V2));assert valid(MONO) and dict(V2.clears)[S]==100
CM=compact(MONO);assert V2 in CM and V1 not in CM
IS90=ev(90,S,(K,N,BS),20,"invalidate",G.id,"hard");assert covers(V2,IS90) and fresh(set(CM)|{IS90},K,G.id)
assert compact(set(compact(MONO))|{G,V0,IS90})==compact(set(MONO)|{IS90})
Vbad=ev(104,R,(K,N,BS),34,"validate",G.id,clears=((R,102),));assert not valid((*MONO,Vbad))
Vdup=replace(Vbad,sequence=105,clears=((S,100),(S,100)));Voverflow=replace(Vbad,sequence=106,clears=((S,2**64),));assert not valid((*MONO,Vdup))and not valid((*MONO,Voverflow))

# Equal input/output values at different provenance revisions transport actual proof.
GI_R=gen(9,R,(KI,NI,BI),5,"a",(10,R));VI_R=ev(10,R,(KI,NI,BI),6,"validate",GI_R.id)
GI_S=gen(99,S,(KI,NI,BI),5,"a",(100,S));VI_S=ev(100,S,(KI,NI,BI),6,"validate",GI_S.id)
DR=replace(mR,inputs=((KI,"a"),));DS=replace(mS,inputs=((KI,"a"),))
XR=Rep(R,10,((A,2),(R,10)),frozenset((GI_R,VI_R,G,V0)),((KI,M("ar",GI_R.id,"a",GI_R.id,5,"fresh",True)),(K,DR)))
XS=Rep(S,100,((A,2),(S,100)),frozenset((GI_S,VI_S,G,V0)),((KI,M("as",GI_S.id,"a",GI_S.id,5,"fresh",True)),(K,DS)))
X1,_=reset(XR,XS,30);X2,xa=receive(X1,XS);assert node(X2,K).proof and node(X2,K).state=="fresh"and not xa

# Unequal reset value: same identifier/generation, scoped edit at tau, no generation.
EY=ev(22,S,(K,N,BS),7,"edit",G.id,value="Y");SY=replace(mS,value="Y",modified=7,origin=EY.id)
YS=Rep(S,22,((A,2),(S,22)),frozenset(set(JS)|{EY}),((K,SY),));Y1,ye=reset(RR,YS,40);ym=node(Y1,K)
assert ym.identifier==mR.identifier and ym.generation==G.id and ym.value=="Y"and ym.modified==40
assert len([e for e in ye if e.kind=="edit"and e.time==40])==1 and not any(e.kind=="add"for e in ye)
Y2,ye2=reset(Y1,YS,40);assert not ye2 and Y2==Y1
EMPTY=Rep(S,1,((S,1),),frozenset(),());YD,yde=reset(RR,EMPTY,40);assert node(YD,K)is None and mR.identifier in YD.retired and any(e.kind=="delete"for e in yde)
YREM,yre=reset(YD,YS,50);assert node(YREM,K).identifier!=mR.identifier and any(e.kind=="add"for e in yre)

# Equal value with numerically greater source generation: no reset fence/edit, timestamp preserved.
GS=gen(99,S,(K,N,BS),5,"d",(100,S));GSV=ev(100,S,(K,N,BS),6,"validate",GS.id)
EQ_S=Rep(S,100,((S,100),),frozenset((GS,GSV)),((K,M("sid",GS.id,"d",GS.id,5,"fresh",True,((KI,"a"),))),))
EQ_R=Rep(R,11,((A,2),(R,11)),JR,((K,mR),))
EQ1,eqe=reset(EQ_R,EQ_S,30);assert not any(e.kind in("add","edit")for e in eqe)and node(EQ1,K).modified==mR.modified
EQ2,eqa=receive(EQ1,EQ_S);assert node(EQ2,K).value=="d"and node(EQ2,K).proof and not eqa
# Third absent host learns only through actual public add; no hidden positive event exists.
ABS=Rep(B,1,((B,1),),frozenset((dele(1,B,(K,N,BS),1),)),())
AB2,_=receive(ABS,EQ_S);assert node(AB2,K)and any(e.kind=="add"for e in EQ_S.journal)

# Fresh source resets stale receiver with joint causal validation and is absorbed.
IHR=ev(12,R,(K,N,BS),12,"invalidate",G.id,"hard");staleR=Rep(R,12,((A,2),(R,12)),frozenset(set(JR)|{IHR}),((K,replace(mR,state="hard",proof=False)),))
assert validate_replica(staleR)and validate_replica(SS)
FR,fe=reset(staleR,SS,30);assert node(FR,K).state=="fresh"and any(e.kind=="validate"for e in fe)
FR2,fa=receive(FR,SS);assert sem(FR2)==sem(FR)and not fa

# Soft target clears independent old hard histories then leaves new soft uncovered.
SGI=gen(1,A,(KI,NI,BI),1,"a",(2,A));SGIV=ev(2,A,(KI,NI,BI),2,"validate",SGI.id)
SGD=gen(3,A,(KD,ND,BD),1,"c",(4,A));SGDV=ev(4,A,(KD,ND,BD),2,"validate",SGD.id)
SGE=gen(5,A,(KE,NE,BE),1,"d",(6,A));SGEV=ev(6,A,(KE,NE,BE),2,"validate",SGE.id)
sroots=((KI,M("si",SGI.id,"a",SGI.id,1,"fresh",True)),(KD,M("sd",SGD.id,"c",SGD.id,1,"fresh",True)))
sderived=M("se",SGE.id,"d",SGE.id,1,"fresh",True,((KI,"a"),(KD,"c")))
softR=Rep(R,0,((A,6),),frozenset((SGI,SGIV,SGD,SGDV,SGE,SGEV)),tuple(sorted((*sroots,(KE,sderived)))))
ISS=ev(7,S,(KE,NE,BE),7,"invalidate",SGE.id,"soft");softS=Rep(S,7,((A,6),(S,7)),frozenset(set(softR.journal)|{ISS}),tuple(sorted((*sroots,(KE,replace(sderived,state="soft"))))))
assert validate_replica(softR)and validate_replica(softS)
Soft1,se=reset(softR,softS,30);assert [e.kind for e in se][-2:]==["validate","invalidate"]and se[-1].mode=="soft"
assert ISS not in Soft1.journal and any(e.author==R and e.kind=="invalidate"and e.mode=="soft" for e in Soft1.journal)
assert any(e.author==R and e.kind=="validate"and dict(e.clears).get(S,0)>=7 for e in Soft1.journal)
Soft2,sa=receive(Soft1,softS);assert node(Soft2,KE).state=="soft"and node(Soft2,KE).proof and not sa
SoftAgain,se2=reset(Soft1,softS,30);assert not se2 and SoftAgain==Soft1

# Losing the reusable proof of stale-soft state is a genuine local hardening;
# reverse receive imports that precise barrier silently.
SIB=ev(90,S,(KI,NI,BI),10,"edit",SGI.id,value="b");SOE=ev(91,S,(KE,NE,BE),0,"edit",SGE.id,value="e")
changedRoots=((KI,M("si2",SGI.id,"b",SIB.id,10,"fresh",True)),sroots[1])
changedDerived=M("se2",SGE.id,"e",SOE.id,0,"soft",True,((KI,"b"),(KD,"c")))
changedSoft=Rep(S,91,((A,6),(S,91)),frozenset(set(softR.journal)|{ISS,SIB,SOE}),tuple(sorted((*changedRoots,(KE,changedDerived)))))
assert validate_replica(changedSoft)
hardened,hardEvents=receive(Soft1,changedSoft);assert len(hardEvents)==1 and hardEvents[0].mode=="hard"and node(hardened,KE).state=="hard"and not node(hardened,KE).proof
reverse,reverseEvents=receive(changedSoft,hardened);assert not reverseEvents and node(reverse,KE).state=="hard"

# Hard source resets fresh receiver: retained local hard assertion, no proof, later no echo.
ISH=ev(22,S,(K,N,BS),22,"invalidate",G.id,"hard");hardS=Rep(S,22,((A,2),(S,22)),frozenset(set(JS)|{ISH}),((K,replace(mS,state="hard",proof=False)),))
assert validate_replica(hardS)
H1,he=reset(RR,hardS,30);assert any(e.kind=="invalidate"and e.mode=="hard"for e in he)and not node(H1,K).proof
H2,ha=receive(H1,hardS);assert node(H2,K).state=="hard"and not ha

# Observed prefix clears delayed A40 but not unseen A51.
G50=gen(1,B,(KD,ND,BD),1,"z",(2,B));GV=ev(2,B,(KD,ND,BD),2,"validate",G50.id)
I40=ev(40,A,(KD,ND,BD),10,"invalidate",G50.id,"hard");Vreset=ev(60,R,(KD,ND,BD),20,"validate",G50.id,clears=((A,50),(B,2)))
assert covers(Vreset,I40) and I40 not in compact((G50,GV,Vreset))
I41=ev(41,A,(KD,ND,BD),21,"invalidate",G50.id,"soft");assert covers(Vreset,I41)
I51=ev(51,A,(KD,ND,BD),21,"invalidate",G50.id,"hard");assert not covers(Vreset,I51)
assert fresh((G50,GV,Vreset,I40),KD,G50.id)and hard((G50,GV,Vreset,I51),KD,G50.id)
Vthrough40=ev(61,R,(KD,ND,BD),22,"validate",G50.id,clears=((A,40),(B,2)));assert covers(Vthrough40,I40)and not covers(Vthrough40,I41)
# Future union with delayed covered evidence agrees around compaction.
CA=frozenset((G50,GV,Vreset));CB=frozenset((G50,GV,I40,I51))
assert compact(compact(CA)|CB)==compact(CA|CB)

# Polling maxima preserve reset transitions and causal stabilization through compaction.
cursor=((R,0),);pollsets=[frozenset(JR|JS|set(xs)) for xs in (ye,fe,he)]+[frozenset(softR.journal|softS.journal|set(se))];acts={a for ps in pollsets for a,_ in query(ps,cursor)}
assert {"edit","validate","invalidate"}<=acts and all(query(ps,cursor)==query(compact(ps),cursor) for ps in pollsets)
# Ordinary add/delete remain explicit.
GADD=gen(70,R,(KD,ND,BD),40,"n",(71,R));VADD=ev(71,R,(KD,ND,BD),40,"validate",GADD.id);DEL=dele(72,R,(KD,ND,BD),41)
assert {a for a,_ in query((GADD,VADD,DEL))}=={"add","validate","delete"}

# Unsupported future-dated source is rejected under the normative wall-clock premise.
EFUT=ev(22,S,(K,N,BS),31,"edit",G.id,value="future");futureS=Rep(S,22,((A,2),(S,22)),frozenset(set(JS)|{EFUT}),((K,replace(mS,value="future",origin=EFUT.id,modified=31)),))
try:reset(RR,futureS,30);assert False
except ValueError:pass

# Explicit DAG proof transport compares evidence to already-selected final inputs.
GI=gen(1,A,(KI,NI,BI),1,"a",(2,A));GIV=ev(2,A,(KI,NI,BI),2,"validate",GI.id)
GD=gen(3,A,(KD,ND,BD),1,"c",(4,A));GDV=ev(4,A,(KD,ND,BD),2,"validate",GD.id)
GE=gen(5,A,(KE,NE,BE),1,"d",(6,A));GEV=ev(6,A,(KE,NE,BE),2,"validate",GE.id)
baseJ=frozenset((GI,GIV,GD,GDV,GE,GEV))
roots=((KI,M("i",GI.id,"a",GI.id,1,"fresh",True)),(KD,M("j",GD.id,"c",GD.id,1,"fresh",True)))
derived=M("d",GE.id,"d",GE.id,1,"fresh",True,((KI,"a"),(KD,"c")))
DL=Rep(A,6,((A,6),),baseJ,tuple(sorted((*roots,(KE,derived)))))
EIB=ev(100,S,(KI,NI,BI),10,"edit",GI.id,value="b")
DRIGHT=Rep(S,100,((A,4),(S,100)),frozenset((GI,GIV,GD,GDV,EIB)),((KI,M("i2",GI.id,"b",EIB.id,10,"fresh",True)),(KD,roots[1][1])))
assert validate_replica(DL)and validate_replica(DRIGHT)
DM,dm_events=receive(DL,DRIGHT);assert not node(DM,KE).proof and node(DM,KE).state=="hard"and len(dm_events)==1
# Same semantic input at a different revision preserves real multi-input proof; duplicate KI is collapsed.
EIA=ev(100,S,(KI,NI,BI),10,"edit",GI.id,value="a")
DEQUAL=Rep(S,100,((A,4),(S,100)),frozenset((GI,GIV,GD,GDV,EIA)),((KI,M("i2",GI.id,"a",EIA.id,10,"fresh",True)),(KD,roots[1][1])))
DEM,de_events=receive(DL,DEQUAL);assert node(DEM,KE).proof and node(DEM,KE).state=="fresh"and not de_events and len(node(DEM,KE).inputs)==2
# Graph/journal-inconsistent hard label is rejected before reset or receive.
INVALID_HARD=replace(DL,nodes=tuple(sorted((*roots,(KE,replace(derived,state="hard",proof=False))))))
assert not validate_replica(INVALID_HARD)
try:reset(DL,INVALID_HARD,20);assert False
except ValueError:pass

# Live NodeIdentifiers form a bijection with keys and never intersect retirement.
multiEmpty=Rep(R,0,(),frozenset(),());multiReset,multiEvents=reset(multiEmpty,DL,20)
multiIds=[m.identifier for _,m in multiReset.nodes];assert len(multiIds)==len(set(multiIds))==3 and multiReset.nextid==4
assert not validate_replica(replace(multiReset,nodes=tuple((k,replace(m,identifier=multiIds[0])) for k,m in multiReset.nodes)))
assert not validate_replica(replace(multiReset,retired=(multiIds[0],)))

# Graph origins must be canonical winning-generation value events.
CG=gen(1,A,(KD,ND,BD),1,"x",(2,A));CGV=ev(2,A,(KD,ND,BD),2,"validate",CG.id)
CE10=ev(10,A,(KD,ND,BD),10,"edit",CG.id,value="old");CE20=ev(20,A,(KD,ND,BD),20,"edit",CG.id,value="new")
superseded=Rep(A,20,((A,20),),frozenset((CG,CGV,CE10,CE20)),((KD,M("cid",CG.id,"old",CE10.id,10,"fresh",True)),))
assert not validate_replica(superseded)
EB=ev(10,B,(KD,ND,BD),5,"edit",CG.id,value="tie");EC=ev(11,C,(KD,ND,BD),5,"edit",CG.id,value="tie")
lowerTie=Rep(R,0,((A,2),(B,10),(C,11)),frozenset((CG,CGV,EB,EC)),((KD,M("tid",CG.id,"tie",EB.id,5,"fresh",True)),))
assert not validate_replica(lowerTie)

# Lazy-clock reverse catch-up includes SemanticGraph equality.
GA=gen(99,A,(KI,NI,BI),1,"a",(100,A));GAV=ev(100,A,(KI,NI,BI),2,"validate",GA.id)
HA=Rep(A,100,((A,100),),frozenset((GA,GAV)),((KI,M("aid",GA.id,"a",GA.id,1,"fresh",True)),))
DB=dele(1,B,(KD,ND,BD),1);HB=Rep(B,1,((B,1),),frozenset((DB,)),())
A1,aa=receive(HA,HB);B1,ba=receive(HB,A1);assert not aa and not ba
assert A1.journal==B1.journal and A1.coverage==B1.coverage and sem(A1)==sem(B1)and B1.clock==1
q=alloc(B1)[0];assert q==101

# Canonical cursor/token scalar domains.
def encode(ch,cur):
 raw=json.dumps({"change":ch,"cursor":[list(x)for x in sorted(cur)],"v":1},sort_keys=True,separators=(",",":"));return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
def decode(tok):
 raw=base64.urlsafe_b64decode(tok+"="*((-len(tok))%4)).decode();o=json.loads(raw)
 if set(o)!={"change","cursor","v"}or o["v"]!=1:raise ValueError
 ch=o["change"]
 if type(ch)is not dict or set(ch)!={"nodeName","bindings","action","time"}or type(ch["nodeName"])is not str or type(ch["bindings"])is not list or ch["action"]not in ACT or not timestamp(ch["time"]):raise ValueError
 prodkey(ch["nodeName"],tuple(ch["bindings"]));cs=o["cursor"]
 if cs!=sorted(cs)or len({x for x,_ in cs})!=len(cs)or any(not regex.fullmatch("[a-z]{16}",x)or not uint(n)for x,n in cs):raise ValueError
 if encode(ch,[tuple(x)for x in cs])!=tok:raise ValueError
 return o
ch={"nodeName":N,"bindings":list(BS),"action":"edit","time":40};tok=encode(ch,((A,10),(B,3)));assert decode(tok)
def bad(o):
 t=base64.urlsafe_b64encode(json.dumps(o,sort_keys=True,separators=(",",":")).encode()).decode().rstrip("=")
 try:decode(t)
 except (ValueError,TypeError,KeyError):return
 raise AssertionError("malformed token accepted")
base={"change":ch,"cursor":[[A,1]],"v":1}
for o in({**base,"cursor":[[A,True]]},{**base,"cursor":[[A,2**64]]},{**base,"cursor":[["bad",1]]},{**base,"cursor":[[A,1],[A,2]]},{**base,"cursor":[[B,1],[A,2]]},{**base,"v":2},{**base,"x":1},{**base,"change":{**ch,"time":True}},{**base,"change":{**ch,"time":TMAX+1}},{**base,"change":{**ch,"nodeName":7}},{**base,"change":{**ch,"bindings":{}}}):bad(o)
noncanon=base64.urlsafe_b64encode(json.dumps(base).encode()).decode().rstrip("=")
try:decode(noncanon);raise AssertionError("noncanonical token accepted")
except ValueError:pass

# Storage-category bounds across a generated n-by-r family, including n=0,r>0.
def bounded_history(n,r):
 authors=(A,B,C,R,S)[:r];addresses=((K,N,BS),(KI,NI,BI),(KD,ND,BD),(KE,NE,BE))[:n];seq={x:0 for x in authors};es=[]
 for address in addresses:
  seq[authors[0]]+=1;gid=(seq[authors[0]],authors[0]);seq[authors[0]]+=1;fid=(seq[authors[0]],authors[0]);g=gen(gid[0],gid[1],address,1,"v",fid);iv=ev(fid[0],fid[1],address,2,"validate",gid);es.extend((g,iv));invalid=[]
  for author in authors:
   seq[author]=max(seq[author],fid[0])+1;i=ev(seq[author],author,address,3,"invalidate",gid,"soft");invalid.append(i);es.append(i)
  prefix=tuple(sorted((i.author,i.sequence)for i in invalid))
  for author in authors:
   seq[author]+=1;es.append(ev(seq[author],author,address,4,"validate",gid,clears=prefix))
 cov=tuple(sorted(seq.items()));return frozenset(es),cov
def category_counts(es):
 cs=compact(es);keys={e.key for e in cs};n=len(keys);authors={e.author for e in cs};r=len(authors)
 P=sum(ph(cs,k)is not None for k in keys);VH=sum(len(vheads(cs,k,generation(cs,k)))for k in keys if generation(cs,k));UF=sum(len(front(cs,k,generation(cs,k)))for k in keys if generation(cs,k));UH=sum(len(front(cs,k,generation(cs,k),True))for k in keys if generation(cs,k));VV=len([e for e in cs if e.kind=="validate"]);coords=sum(len(e.clears)for e in cs if e.kind=="validate")
 return cs,n,r,len(nmax(cs)),P,VH,UF,UH,VV,coords
for n in range(1,5):
 for r in range(1,6):
  es,cov=bounded_history(n,r);cs,nn,rr,Nc,P,VH,UF,UH,VV,coords=category_counts(es);assert(nn,rr)==(n,r)
  assert Nc<=5*n*r and P<=n and VH<=n*r and UF<=n*r and UH<=n*r and VV<=2*n*r and coords<=2*n*r*r
  assert len(cs)+coords+len(cov)<=12*n*r+2*n*r*r+r
for r in range(1,6):
 cov=tuple((x,10)for x in(A,B,C,R,S)[:r]);assert compact(())==frozenset()and len(cov)==r

print("journal semantic verifier passed: convergence, causal validation, observed reset absorption/idempotence, extensional proof transport, polling, compaction, lazy clock, timestamps, and storage")
