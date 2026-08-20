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
 target:tuple|None=None;lineage:tuple|None=None
 @property
 def id(self):return(self.sequence,self.author)
def gen(q,a,address,t,val,initial):k,n,b=address;return E(q,a,k,t,n,b,"add",initial=initial,value=val)
def ev(q,a,address,t,kind,g,mode=None,clears=(),value=None,target=None,lineage=None):
 k,n,b=address
 if kind=="validate"and target is None:target=g
 return E(q,a,k,t,n,b,kind,g,mode=mode,clears=tuple(sorted(clears)),value=value,target=target,lineage=lineage)
def observe(q,a,address,t,target,lineage):k,n,b=address;return E(q,a,k,t,n,b,"observe",target=target,lineage=lineage)
def dele(q,a,address,t,lineage=None):k,n,b=address;return E(q,a,k,t,n,b,"delete",lineage=lineage)
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
   if e.generation or not e.initial or e.mode or e.clears or e.target or e.lineage:return False
  elif e.kind=="delete":
   if e.generation or e.initial or e.mode or e.clears or e.target:return False
  elif e.kind in ("edit","invalidate","validate"):
   if not e.generation or e.initial:return False
   if e.kind=="invalidate" and e.mode not in ("soft","hard"):return False
   if e.kind!="invalidate" and e.mode:return False
   if e.kind!="validate" and e.clears:return False
   if e.target and e.kind not in ("invalidate","validate"):return False
   if e.kind=="validate"and not e.target:return False
  elif e.kind=="observe":
   if e.generation or e.initial or e.mode or e.clears or e.value or not e.lineage:return False
  else:return False
  if e.lineage:
   if e.kind not in ("delete","invalidate","validate","observe"):return False
   if type(e.lineage)is not tuple or len(e.lineage)!=3:return False
   through,sg,so=e.lineage
   if type(through)is not tuple or tuple(sorted(through))!=through or len({a for a,_ in through})!=len(through)or any(a not in AUTH or not uint(q)for a,q in through):return False
   if (sg is None)!=(so is None):return False
   if e.kind in ("delete","observe")and sg is not None:return False
   if e.kind in ("validate","invalidate")and sg is None:return False
   if sg is not None and any(type(x)is not tuple or len(x)!=2 or not uint(x[0])or x[0]==0 or x[1]not in AUTH for x in(sg,so)):return False
  if tuple(sorted(e.clears))!=e.clears or len({a for a,_ in e.clears})!=len(e.clears) or any(a not in AUTH or not uint(q) for a,q in e.clears):return False
 for e in es:
  if e.generation:
   g=d.get(e.generation)
   if not g or g.kind!="add" or g.key!=e.key:return False
   if e.target:
    t=d.get(e.target)
    if not t or t.key!=e.key or not((t.kind=="add"and t.id==e.generation)or(t.kind=="edit"and t.generation==e.generation)):return False
  if e.kind=="observe"and e.target:
   t=d.get(e.target)
   if not t or t.key!=e.key or t.kind!="delete":return False
  if e.kind=="add":
   f=d.get(e.initial)
   if not f or f.kind not in ("validate","invalidate") or f.author!=e.author or f.sequence<=e.sequence or f.key!=e.key or f.generation!=e.id:return False
 vals=[e for e in es if e.kind=="validate"]
 for v1 in vals:
  for v2 in vals:
   if (v1.author,v1.key,v1.generation)==(v2.author,v2.key,v2.generation) and v1.sequence<v2.sequence:
    later=dict(v2.clears)
    if any(later.get(a,0)<q for a,q in v1.clears):return False
 return True
def raw_ph(es,k):
 x=[e for e in es if e.key==k and e.kind in ("add","delete")];return max(x,key=lambda e:e.id) if x else None
def ph(es,k):
 """Activate reset lineages, then order only generation/delete presence events."""
 base=raw_ph(es,k)
 by={e.id:e for e in es};eligible=[];certs=[]
 for cert in es:
  if cert.key!=k or not cert.lineage:continue
  if cert.kind=="observe":
   # A null target is a virtual explicit-absence anchor.  It continues to
   # interpret later unions; otherwise delayed consumed history could make the
   # certificate disappear precisely when it is needed.
   if cert.target is not None and (not base or cert.target!=base.id):continue
  elif cert.kind=="delete":
   if not base or cert.id!=base.id:continue
  else:
   if not base or cert.target not in by:continue
   target=by[cert.target];receiver_g=target.id if target.kind=="add"else target.generation
   if base.kind!="add"or receiver_g!=base.id:continue
  certs.append(cert)
 if not certs:return base
 virtual_absence=any(cert.kind=="observe"and cert.target is None for cert in certs)
 anchored_base=any(cert.kind!="observe"or cert.target is not None for cert in certs)
 cut={};consumed=set()
 for cert in certs:
  for a,q in cert.lineage[0]:cut[a]=max(cut.get(a,0),q)
  if cert.lineage[1]is not None:consumed.add(cert.lineage[1])
 for e in es:
  if e.key!=k or(base and e.id==base.id and anchored_base)or e.sequence<=cut.get(e.author,0):continue
  if e.kind in ("add","delete"):eligible.append(e)
  elif e.generation in consumed or ((not base or e.generation!=base.id)and e.generation in by and by[e.generation].sequence>cut.get(by[e.generation].author,0)):
   eligible.append(by[e.generation])
 return max(eligible,key=lambda e:e.id) if eligible else(base if anchored_base else(None if virtual_absence else base))
def generation(es,k):p=ph(es,k);return p.id if p and p.kind=="add" else None
def vheads(es,k,g):
 o={}
 for e in es:
  if (e.kind=="add" and e.id==g) or(e.kind=="edit" and e.key==k and e.generation==g):
   if e.author not in o or o[e.author].sequence<e.sequence:o[e.author]=e
 return frozenset(o.values())
def origin(es,k,g,t):return max((e for e in vheads(es,k,g) if e.time==t),key=lambda e:e.id)
def front(es,k,g,hard=False,value_origin=None):
 o={}
 for e in es:
  if e.kind=="invalidate" and e.key==k and e.generation==g and(not hard or e.mode=="hard")and(value_origin is None or e.target is None or e.target==value_origin):
   if e.author not in o or o[e.author].sequence<e.sequence:o[e.author]=e
 return frozenset(o.values())
def covers(v,i):return v.kind=="validate" and v.key==i.key and v.generation==i.generation and i.sequence<=dict(v.clears).get(i.author,0)
def eff(v,es,k,g,hard=False,value_origin=None):return v.key==k and v.generation==g and v.target==value_origin and all(covers(v,i) for i in front(es,k,g,hard,value_origin))
def fresh(es,k,g,value_origin=None):
 value_origin=g if value_origin is None else value_origin;return any(eff(v,es,k,g,False,value_origin) for v in es if v.kind=="validate")
def hard(es,k,g,value_origin=None):
 value_origin=g if value_origin is None else value_origin
 f=front(es,k,g,True,value_origin);return bool(f)and not any(eff(v,es,k,g,True,value_origin) for v in es if v.kind=="validate")
def nmax(es):
 o={}
 for e in es:
  if e.kind=="observe":continue
  c=(e.author,e.key,e.kind)
  if c not in o or o[c].sequence<e.sequence:o[c]=e
 return frozenset(o.values())
def compact(es):
 es=frozenset(es);assert valid(es);by={e.id:e for e in es};keep=set(nmax(es))
 for k in {e.key for e in es}:
  p=ph(es,k);raw=raw_ph(es,k)
  if p:keep.add(p)
  # Reset lineage is future presence authority even while causal presence is
  # absent, so select it independently of winning-generation value seeds.
  applicable=[]
  for e in es:
   if e.key!=k or not e.lineage:continue
   anchored=e.kind=="observe"and(e.target is None or(raw and e.target==raw.id))
   if e.kind=="delete"and raw:anchored=e.id==raw.id
   if e.kind not in("delete","observe")and raw and raw.kind=="add"and e.target in by:
    t=by[e.target];anchored=(t.id if t.kind=="add"else t.generation)==raw.id
   if anchored:applicable.append(e)
  exact={};coordinates={}
  for e in applicable:
   pair=(e.target,*e.lineage[1:])
   if e.lineage[1:]!=(None,None)and(pair not in exact or exact[pair].id<e.id):exact[pair]=e
   for a,q in e.lineage[0]:
    if a not in coordinates or(coordinates[a].lineage[0]and(dict(coordinates[a].lineage[0]).get(a,0),coordinates[a].id)<(q,e.id)):coordinates[a]=e
  keep.update(exact.values());keep.update(coordinates.values())
  if applicable and not exact and not coordinates:keep.add(max(applicable,key=lambda e:e.id))
  g=p.id if p and p.kind=="add" else None
  if not g:continue
  heads=vheads(es,k,g);keep.update(heads)
  vals={}
  for v in es:
   if v.kind=="validate" and v.key==k and v.generation==g:
    c=(v.author,v.target)
    if c not in vals or vals[c].sequence<v.sequence:vals[c]=v
  keep.update(vals.values())
  # Preserve each complete frontier. Removing members against different partial
  # validations would manufacture a combined validation that never occurred.
  for h in heads:
   keep.update(front(es,k,g,False,h.id));keep.update(front(es,k,g,True,h.id))
 changed=True
 while changed:
  changed=False
  for e in tuple(keep):
   refs=([e.generation]if e.generation else[])+([e.initial]if e.kind=="add"else[])+([e.target]if e.target else[])
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
def const_bytes(value):
 if type(value)is bool:return b"b1"if value else b"b0"
 if type(value)in (int,float):
  try:number=float(value)
  except OverflowError:raise ValueError("non-finite ConstValue number")
  if not math.isfinite(number):raise ValueError("non-finite ConstValue number")
  # JavaScript === equates both zero signs and every integer/float spelling of
  # the same Number. float.hex is an injective canonical encoding thereafter.
  if number==0:number=0.0
  return ("n"+number.hex()).encode()
 if type(value)is str:
  data=value.encode();return b"s"+str(len(data)).encode()+b":"+data
 if type(value)is list:
  parts=[const_bytes(x)for x in value];return b"a"+b"".join(str(len(x)).encode()+b":"+x for x in parts)
 if type(value)is dict and all(type(k)is str for k in value):
  parts=[]
  for k,v in value.items():parts.extend((const_bytes(k),const_bytes(v)))
  return b"o"+b"".join(str(len(x)).encode()+b":"+x for x in parts)
 raise ValueError("value is outside ConstValue")
def filter_bytes(f):
 if f==("wildcard",):return b"W"
 if type(f)is not tuple or not f:raise ValueError("invalid filter")
 if f[0]=="ground"and len(f)==3 and type(f[1])is str and type(f[2])is tuple:
  head=const_bytes(f[1]);args=[]
  for a in f[2]:
   x=b"W"if a==("wildcard",)else b"C"+const_bytes(a);args.append(str(len(x)).encode()+b":"+x)
  return b"G"+str(len(head)).encode()+b":"+head+b"".join(args)
 if f[0]=="union"and len(f)==3:
  children=sorted((filter_bytes(f[1]),filter_bytes(f[2])))
  return b"U"+b"".join(str(len(x)).encode()+b":"+x for x in children)
 raise ValueError("invalid filter")
def filter_identity(f):return base64.urlsafe_b64encode(filter_bytes(f)).decode().rstrip("=")
def filter_matches(f,e):
 if f==("wildcard",):return True
 if f[0]=="union":return filter_matches(f[1],e)or filter_matches(f[2],e)
 if f[0]!="ground"or f[1]!=e.name or len(f[2])!=len(e.bindings):return False
 return all(a==("wildcard",)or is_equal(a,b)for a,b in zip(f[2],e.bindings))
def filtered_query(es,cursor,f,token_filter=None):
 filter_id=filter_identity(f)
 if token_filter is not None and token_filter!=filter_id:raise ValueError("cursor filter mismatch")
 d=dict(cursor);out=[]
 for e in sorted((e for e in nmax(es)if e.sequence>d.get(e.author,0)and filter_matches(f,e)),key=lambda e:e.id):
  d[e.author]=e.sequence;out.append((e.kind,tuple(sorted(d.items())),filter_id))
 return tuple(out)
def journal_projection(es):
 out=[]
 for k in sorted({e.key for e in es}):
  p=ph(es,k);g=generation(es,k);values=()
  if g:
   heads=vheads(es,k,g);values=tuple(sorted((t,origin(es,k,g,t).id)for t in {e.time for e in heads}))
  states=()if not g else tuple(sorted((h.id,fresh(es,k,g,h.id),hard(es,k,g,h.id))for h in vheads(es,k,g)))
  out.append((k,None if not p else(p.kind,p.id),g,values,states))
 return tuple(out),query(es)
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
def carry_prefix(j,author,key,g,target,new=()):
 d=dict(new)
 prior=[v for v in j if v.kind=="validate"and v.author==author and v.key==key and v.generation==g]
 if prior:
  for a,q in max(prior,key=lambda v:v.sequence).clears:d[a]=max(d.get(a,0),q)
 return tuple(sorted(d.items()))
def add_events(r,events):
 j=merge(r.journal,events);q=max(e.sequence for e in events);return replace(r,clock=q,coverage=vmax(r.coverage,((r.fp,q),)),journal=j)
def classify(j,k,g,value_origin=None):return"hard"if hard(j,k,g,value_origin)else("fresh"if fresh(j,k,g,value_origin)else"soft")
def revision(m):return(m.modified,m.origin[0],m.origin[1])
def greatest_candidate(candidates):
 top=max(revision(m)for m in candidates);return min((m for m in candidates if revision(m)==top),key=lambda m:m.identifier)
def admissible_candidates(j,k,g,candidates):
 out=[]
 for m in candidates:
  if not m or m.value is None or m.generation!=g:continue
  try:c=origin(j,k,g,m.modified)
  except (ValueError,KeyError):continue
  if c.id==m.origin:out.append(m)
 return out
def proof_coherent(m,deps,final_inputs):
 if not m.proof:return False
 evidence=dict(m.inputs)
 return set(evidence)==set(deps)and all(is_equal(evidence[d],final_inputs[d])for d in deps)
def reset_lineage_covers(j,receiver,source):
 return any(e.target==receiver.origin and e.lineage and e.lineage[1:]==(source.generation,source.origin)for e in j if e.kind in("validate","invalidate","observe"))
def choose_value(j,k,candidates,deps=(),final_inputs=None):
 p=ph(j,k)
 if not p or p.kind=="delete":return None
 g=p.id;usable=admissible_candidates(j,k,g,candidates)
 if not usable:return(g,None,False)
 if not deps:return(g,greatest_candidate(usable),False)
 coherent=[m for m in usable if proof_coherent(m,deps,final_inputs)]
 if coherent:return(g,greatest_candidate(coherent),True)
 certified=[m for m in usable for other in candidates if other and other is not m and reset_lineage_covers(j,m,other)]
 if certified:return(g,greatest_candidate(certified),False)
 if len(deps)==1:return(g,greatest_candidate(usable),False)
 if len(usable)==2 and revision(usable[0])==revision(usable[1]):return(g,min(usable,key=lambda m:m.identifier),False)
 return(g,None,False)

def validate_replica(r,schema=SCHEMA):
 if not valid(r.journal):return False
 cov=dict(r.coverage)
 if cov.get(r.fp,0)!=r.clock or any(cov.get(e.author,0)<e.sequence for e in r.journal):return False
 nd=dict(r.nodes)
 live=[m.identifier for _,m in r.nodes]
 if len(set(live))!=len(live) or set(live)&set(r.retired):return False
 for k,m in r.nodes:
  if k not in schema or generation(r.journal,k)!=m.generation:return False
  candidates=[e for e in r.journal if ((e.kind=="add"and e.id==m.origin)or(e.kind=="edit"and e.id==m.origin)) and e.key==k and ((e.kind=="add"and e.id==m.generation)or e.generation==m.generation)]
  try:canonical=origin(r.journal,k,m.generation,m.modified)
  except (ValueError,KeyError):return False
  if not candidates or canonical.id!=m.origin or candidates[0].time!=m.modified or not is_equal(candidates[0].value,m.value):return False
  if classify(r.journal,k,m.generation,m.origin)!=m.state:return False
  deps=tuple(dict.fromkeys(schema[k]))
  if any(d not in nd for d in deps):return False
  if m.state=="hard"and m.proof:return False
  if m.state=="soft"and (not deps or not m.proof):return False
  if m.state=="fresh"and deps and (not m.proof or any(nd[d].state!="fresh"for d in deps)):return False
  if m.proof and deps:
   evidence=dict(m.inputs)
   if set(evidence)!=set(deps) or any(not is_equal(evidence[d],nd[d].value)for d in deps):return False
 return all((ph(r.journal,k)and ph(r.journal,k).kind=="delete")or k in nd for k in {e.key for e in r.journal if e.kind in("add","delete")})

def topo(schema):
 out=[];remaining=set(schema)
 while remaining:
  ready=[k for k in schema if k in remaining and set(schema[k])<=set(out)]
  if not ready:raise ValueError("cyclic schema")
  out.extend(ready);remaining-=set(ready)
 return out
def receive(r,s,tau=None,schema=SCHEMA):
 if not validate_replica(r,schema)or not validate_replica(s,schema):raise ValueError("unsupported replica")
 j=merge(r.journal,s.journal);cov=vmax(r.coverage,s.coverage);nodes={};authored=[]
 order=topo(schema);universe=set(dict(r.nodes))|set(dict(s.nodes))|{e.key for e in j}
 absent={k for k in universe if not ph(j,k)or ph(j,k).kind=="delete"}
 changed=True
 while changed:
  changed=False
  for k in order:
   if k in universe and k not in absent and any(d in absent for d in set(schema[k])):
    absent.add(k);changed=True
 retired=list(r.retired)
 for k in order:
  if k not in absent:continue
  rm=node(r,k)
  if rm and rm.identifier not in retired:retired.append(rm.identifier)
  if (node(r,k)or node(s,k))and (not ph(j,k)or ph(j,k).kind!="delete"):
   if tau is None:raise ValueError("receive decision requires occurrence time")
   q=alloc(replace(r,journal=j,coverage=cov),1)[0];d=dele(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau);authored.append(d);j=merge(j,(d,));cov=vmax(cov,((r.fp,q),))
 for k in order:
  if k not in universe or k in absent:continue
  deps=tuple(dict.fromkeys(schema[k]))
  if any(d not in nodes for d in deps):
   selected=None
  else:
   final_inputs={d:nodes[d].value for d in deps};selected=choose_value(j,k,[node(r,k),node(s,k)],deps,final_inputs)
  if not selected or selected[1] is None:
   absent.add(k);rm=node(r,k)
   if rm and rm.identifier not in retired:retired.append(rm.identifier)
   if not ph(j,k)or ph(j,k).kind!="delete":
    if tau is None:raise ValueError("receive decision requires occurrence time")
    q=alloc(replace(r,journal=j,coverage=cov),1)[0];d=dele(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau);authored.append(d);j=merge(j,(d,));cov=vmax(cov,((r.fp,q),))
   continue
  g,best,proof=selected
  st=classify(j,k,g,best.origin);inputs_fresh=all(nodes[d].state=="fresh"for d in deps)
  if st=="hard":proof=False
  if st=="fresh"and deps and proof and not inputs_fresh:
   if tau is None:raise ValueError("receive decision requires occurrence time")
   q=alloc(replace(r,journal=j,coverage=cov),1)[0];i=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"invalidate",g,"soft",target=best.origin);authored.append(i);j=merge(j,(i,));cov=vmax(cov,((r.fp,q),));st="soft"
  operational_soft=st=="soft"and bool(deps)and proof
  if (st=="soft"and not operational_soft)or(st=="fresh"and deps and not proof):
   if tau is None:raise ValueError("receive decision requires occurrence time")
   q=alloc(replace(r,journal=j,coverage=cov),1)[0];h=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"invalidate",g,"hard",target=best.origin);authored.append(h);j=merge(j,(h,));cov=vmax(cov,((r.fp,q),));st="hard"
  if not deps:proof=st=="fresh"
  nodes[k]=M(best.identifier,g,best.value,best.origin,best.modified,st,proof,tuple(sorted(final_inputs.items()))if proof and deps else())
 out=Rep(r.fp,max([r.clock]+[e.sequence for e in authored]),cov,j,tuple(sorted(nodes.items())),r.nextid,tuple(retired))
 if not validate_replica(out,schema):raise AssertionError("receive produced unsupported replica")
 return out,tuple(authored)
def best_key_name(k):
 for v in KV:
  if v["serialized"]==k:return v["nodeName"]
 raise KeyError
def best_key_bindings(k):
 for v in KV:
  if v["serialized"]==k:return tuple(v["bindings"])
 raise KeyError

def validation_absorbing(es,k,g,target,closed):
 return any(v.kind=="validate"and v.key==k and v.generation==g and v.target==target and all(dict(v.clears).get(a,0)>=q for a,q in closed)for v in es)
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
def reset_lineage_through(r,s,k,sg,so,ignore_bookkeeping=False):
 prior=[e.lineage[0]for e in r.journal if e.key==k and e.lineage]
 carried=()
 for p in prior:carried=vmax(carried,p)
 # Reset consumes the source snapshot's durable per-key causal semantics, not
 # merely the source container's journalCoverage. Exact correspondences remain
 # exact and are not inferred or transitively copied from these vectors.
 for e in s.journal:
  if e.key==k and e.lineage:carried=vmax(carried,e.lineage[0])
 out=dict(vmax(carried,s.coverage));anchors={e.target for e in r.journal if e.lineage and e.target}
 for e in r.journal:
  # Reset carriers and their receiver anchors are explicitly marked
  # bookkeeping. Every other retained public event for this key is genuine
  # receiver history and advances the next observation.
  if e.key!=k or(ignore_bookkeeping and(e.kind=="observe"or e.lineage or e.id in anchors)):continue
  out[e.author]=max(out.get(e.author,0),e.sequence)
 return tuple(sorted(out.items()))
def reset(r,s,tau):
 if not validate_replica(r)or not validate_replica(s):raise ValueError("unsupported replica")
 if any(m.modified>tau for _,m in s.nodes):raise ValueError("unsupported clock")
 nodes={};events=[];work=r;watermark=observed_watermark(r,s);nextid=r.nextid
 for k in [KI,KD,K,KE]:
  sm=node(s,k)
  if not sm:continue
  rm=node(r,k);target=sm.state
  corr=(reset_lineage_through(r,s,k,sm.generation,sm.origin,rm is not None and is_equal(rm.value,sm.value)and rm.state==target),sm.generation,sm.origin);deps=tuple(dict.fromkeys(SCHEMA[k]));final_inputs={d:nodes[d].value for d in deps}
  proof=True if not deps else sm.proof and set(dict(sm.inputs))==set(deps)and all(is_equal(dict(sm.inputs)[d],final_inputs[d])for d in deps)
  if target=="hard":proof=False
  if rm is None:
   q1,q2=alloc(work,2,watermark);g=gen(q1,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,sm.value,(q2,r.fp));fkind="validate"if target=="fresh"else"invalidate";mode=None if target=="fresh"else target.replace("stale-","");clears=carry_prefix(work.journal,r.fp,k,g.id,g.id,vmax(r.coverage,s.coverage))if fkind=="validate"else();f=ev(q2,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,fkind,g.id,mode,clears,target=g.id,lineage=corr);events.extend((g,f));work=add_events(work,(g,f));m=M(f"{r.fp}-{nextid}",g.id,sm.value,g.id,tau,target,proof,tuple(sorted(final_inputs.items()))if proof and deps else());nextid+=1
  else:
   m=replace(rm,value=sm.value,proof=proof,state=target,inputs=tuple(sorted(final_inputs.items()))if proof and deps else())
   value_changed=False
   if not is_equal(rm.value,sm.value):
    q=alloc(work,1,watermark)[0];e=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"edit",rm.generation,value=sm.value);events.append(e);work=add_events(work,(e,));m=replace(m,origin=e.id,modified=tau);value_changed=True
   g=m.generation;retained=set(work.journal);closed=reset_closed(r,s,k,g,target);needs_corr=(m.generation,m.origin)!=(sm.generation,sm.origin)and not any(e.target==m.origin and e.lineage==corr for e in retained)
   if target=="fresh"and (value_changed or needs_corr or not validation_absorbing(retained,k,g,m.origin,closed)):
    q=alloc(work,1,watermark)[0];c=carry_prefix(work.journal,r.fp,k,g,m.origin,closed);v=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"validate",g,clears=c,target=m.origin,lineage=corr if needs_corr else None);events.append(v);work=add_events(work,(v,))
   elif target=="soft":
    absorbed=validation_absorbing(retained,k,g,m.origin,closed)
    retained_soft=not value_changed and not needs_corr and absorbed and classify(retained,k,g,m.origin)=="soft"
    if not retained_soft:
     new=[]
     if not absorbed:
      q=alloc(work,1,watermark)[0];c=carry_prefix(work.journal,r.fp,k,g,m.origin,closed);v=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"validate",g,clears=c,target=m.origin,lineage=corr);new.append(v);work=add_events(work,(v,))
     q=alloc(work,1,watermark)[0];i=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"invalidate",g,"soft",target=m.origin,lineage=corr if needs_corr else None);new.append(i);work=add_events(work,(i,));events.extend(new)
   elif target=="hard"and (value_changed or needs_corr or not hard(set(work.journal)|set(events),k,g,m.origin)):
    q=alloc(work,1,watermark)[0];i=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"invalidate",g,"hard",target=m.origin,lineage=corr if needs_corr else None);events.append(i);work=add_events(work,(i,))
  nodes[k]=m
 retired=list(r.retired)
 for k,rm in r.nodes:
  if node(s,k)is None:
   q=alloc(work,1,watermark)[0];corr=(reset_lineage_through(r,s,k,None,None),None,None);d=dele(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,corr);events.append(d);work=add_events(work,(d,));retired.append(rm.identifier)
 # Absent-to-absent reset has no public action. Record its causal observation in
 # the same journal with an internal entry anchored to the existing absence.
 for k in SCHEMA:
  if node(r,k)is not None or node(s,k)is not None:continue
  if raw_ph(r.journal,k)is None and raw_ph(s.journal,k)is None and not any(e.key==k and e.lineage for e in r.journal|s.journal):continue
  anchor=raw_ph(work.journal,k);target=anchor.id if anchor and anchor.kind=="delete"else None
  through=reset_lineage_through(r,s,k,None,None,True);joined={}
  for e in work.journal:
   anchored=e.kind=="observe"and e.target==target or e.kind=="delete"and e.id==target
   if anchored and e.key==k and e.lineage:
    for a,n in e.lineage[0]:joined[a]=max(joined.get(a,0),n)
  if any(joined.get(a,0)<n for a,n in through):
   q=alloc(work,1,watermark)[0];o=observe(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,target,(through,None,None));events.append(o);work=add_events(work,(o,))
 out=replace(work,nodes=tuple(sorted(nodes.items())),nextid=nextid,retired=tuple(retired))
 if not validate_replica(out):raise AssertionError("reset produced unsupported replica")
 return out,tuple(events)

# Common generation and independent fresh histories expose naive fresh+fresh -> hard.
G=gen(1,A,(K,N,BS),1,"d",(2,A));V0=ev(2,A,(K,N,BS),2,"validate",G.id,clears=())
crossG=gen(10,A,(KD,ND,BD),1,"bad",(20,B));crossV=ev(20,B,(KD,ND,BD),2,"validate",crossG.id);assert not valid((crossG,crossV))
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

# A reset to explicit absence has a metadata-only virtual anchor even when the
# receiver has no presence history.  Delayed consumed presence stays absorbed,
# while a post-cutoff materialization remains live and polling sees no fake act.
NG=gen(5,S,(KD,ND,BD),5,"old",(6,S));NV=ev(6,S,(KD,ND,BD),6,"validate",NG.id);ND10=dele(10,S,(KD,ND,BD),10)
emptyR=Rep(R,0,(),frozenset(),());absentS=Rep(S,10,((S,10),),frozenset((NG,NV,ND10)),())
absentReset,absenceEvents=reset(emptyR,absentS,20)
nullObs=[e for e in absenceEvents if e.kind=="observe"and e.key==KD and e.target is None]
assert len(nullObs)==1 and not nmax(nullObs)and generation(absentReset.journal,KD)is None
lagged=frozenset(set(absentReset.journal)|{NG,NV});assert generation(lagged,KD)is None
assert generation(compact(absentReset.journal),KD)is None and generation(compact(lagged),KD)is None
NG11=gen(11,S,(KD,ND,BD),11,"new",(12,S));NV12=ev(12,S,(KD,ND,BD),12,"validate",NG11.id)
post=frozenset(set(lagged)|{NG11,NV12});assert generation(post,KD)==NG11.id
ND13=dele(13,S,(KD,ND,BD),13);NG14=gen(14,S,(KD,ND,BD),14,"again",(15,S));NV15=ev(15,S,(KD,ND,BD),15,"validate",NG14.id)
assert generation(set(post)|{ND13},KD)is None and generation(set(post)|{ND13,NG14,NV15},KD)==NG14.id
absentRepeat,absentRepeatEvents=reset(absentReset,absentS,20);assert absentRepeat==absentReset and not absentRepeatEvents

# Reset-of-reset consumes source per-key lineage even when neither side has a
# raw presence head or imported B coverage.
sourceNull=observe(1,S,(KD,ND,BD),10,None,(((B,20),),None,None))
sourceObserved=Rep(S,1,((S,1),),frozenset((sourceNull,)),())
resetOfReset,rorEvents=reset(emptyR,sourceObserved,30)
ror=next(e for e in rorEvents if e.key==KD and e.kind=="observe");assert dict(ror.lineage[0])[B]==20
B5=gen(5,B,(KD,ND,BD),5,"old-b",(6,B));B6=ev(6,B,(KD,ND,BD),6,"validate",B5.id);assert generation(resetOfReset.journal|{B5,B6},KD)is None
receiverNull=observe(1,R,(KD,ND,BD),10,None,(((A,10),),None,None));receiverObserved=Rep(R,1,((R,1),),frozenset((receiverNull,)),())
joinedReset,joinedEvents=reset(receiverObserved,sourceObserved,30);joinedObs=next(e for e in joinedEvents if e.key==KD)
assert dict(joinedObs.lineage[0])[A]==10 and dict(joinedObs.lineage[0])[B]==20
joinedRepeat,joinedRepeatEvents=reset(joinedReset,sourceObserved,30);assert joinedRepeat==joinedReset and not joinedRepeatEvents
B21=gen(21,B,(KD,ND,BD),31,"live",(22,B));B22=ev(22,B,(KD,ND,BD),32,"validate",B21.id);assert generation(joinedReset.journal|{B21,B22},KD)==B21.id
compactedJoined=replace(joinedReset,journal=compact(joinedReset.journal));assert reset(compactedJoined,sourceObserved,30)==(compactedJoined,())

# A later present reset anchor protects its receiver generation from an older
# null-absence observation, while retaining that observation for delayed data.
O0=observe(1,R,(K,N,BS),1,None,(((S,10),),None,None));S11=gen(11,S,(K,N,BS),11,"A",(12,S));S12=ev(12,S,(K,N,BS),12,"validate",S11.id)
presentAfterNull=Rep(R,1,((R,1),(S,12)),frozenset((O0,S11,S12)),((K,M("pan",S11.id,"A",S11.id,11,"fresh",True)),))
TG=gen(20,C,(K,N,BS),20,"A",(21,C));TV=ev(21,C,(K,N,BS),21,"validate",TG.id);presentSource=Rep(C,21,((C,21),),frozenset((TG,TV)),((K,M("pst",TG.id,"A",TG.id,20,"fresh",True)),))
presentAnchored,presentAnchorEvents=reset(presentAfterNull,presentSource,30)
assert node(presentAnchored,K).generation==S11.id and generation(presentAnchored.journal,K)==S11.id and any(e.lineage and e.target==S11.id for e in presentAnchorEvents)
presentCompacted=replace(presentAfterNull,journal=compact(presentAfterNull.journal));presentAnchoredC,_=reset(presentCompacted,presentSource,30);assert generation(presentAnchoredC.journal,K)==S11.id

# Present source lineage is durable reset input even when its causal coordinate
# is absent from source journalCoverage.
TLINE=replace(TV,lineage=(((B,20),),TG.id,TG.id));presentLineageSource=replace(presentSource,journal=frozenset((TG,TLINE)))
fromPresentLineage,fromPresentEvents=reset(emptyR,presentLineageSource,30)
assert any(e.lineage and dict(e.lineage[0]).get(B)==20 for e in fromPresentEvents)

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
V2=ev(103,R,(K,N,BS),33,"validate",G.id,clears=carry_prefix(frozenset((G,V0,V1,IL)),R,K,G.id,G.id,((R,102),)))
MONO=frozenset((G,V0,V1,IL,V2));assert valid(MONO) and dict(V2.clears)[S]==100
CM=compact(MONO);assert V2 in CM and V1 not in CM
IS90=ev(90,S,(K,N,BS),20,"invalidate",G.id,"hard");assert covers(V2,IS90) and fresh(set(CM)|{IS90},K,G.id)
assert compact(set(compact(MONO))|{G,V0,IS90})==compact(set(MONO)|{IS90})
Vbad=ev(104,R,(K,N,BS),34,"validate",G.id,clears=((R,102),));assert not valid((*MONO,Vbad))
Vdup=replace(Vbad,sequence=105,clears=((S,100),(S,100)));Voverflow=replace(Vbad,sequence=106,clears=((S,2**64),));assert not valid((*MONO,Vdup))and not valid((*MONO,Voverflow))

# Whole-frontier retention prevents two partial validations from combining through compaction.
HR=ev(30,R,(K,N,BS),30,"invalidate",G.id,"hard");PVR=ev(31,R,(K,N,BS),31,"validate",G.id,clears=((R,30),));SR=ev(32,R,(K,N,BS),32,"invalidate",G.id,"soft")
HS=ev(40,S,(K,N,BS),40,"invalidate",G.id,"hard");PVS=ev(41,S,(K,N,BS),41,"validate",G.id,clears=((S,40),));SSOFT=ev(42,S,(K,N,BS),42,"invalidate",G.id,"soft")
partialR=frozenset((G,V0,HR,PVR,SR));partialS=frozenset((G,V0,HS,PVS,SSOFT));partial=partialR|partialS
assert not hard(partialR,K,G.id)and not fresh(partialR,K,G.id)and not hard(partialS,K,G.id)and not fresh(partialS,K,G.id)
assert hard(partial,K,G.id)and not fresh(partial,K,G.id)
partialCompact=compact(partial);assert {HR,HS,SR,SSOFT}<=partialCompact
assert hard(partial,K,G.id)==hard(partialCompact,K,G.id)and fresh(partial,K,G.id)==fresh(partialCompact,K,G.id)
assert journal_projection(partial)==journal_projection(partialCompact)
assert compact(compact(partialR)|partialS)==compact(partial)

# Equal input/output values at different provenance revisions transport actual proof.
GI_R=gen(9,R,(KI,NI,BI),5,"a",(10,R));VI_R=ev(10,R,(KI,NI,BI),6,"validate",GI_R.id)
GI_S=gen(99,S,(KI,NI,BI),5,"a",(100,S));VI_S=ev(100,S,(KI,NI,BI),6,"validate",GI_S.id)
DR=replace(mR,inputs=((KI,"a"),));DS=replace(mS,inputs=((KI,"a"),))
XR=Rep(R,10,((A,2),(R,10)),frozenset((GI_R,VI_R,G,V0)),((KI,M("ar",GI_R.id,"a",GI_R.id,5,"fresh",True)),(K,DR)))
XS=Rep(S,100,((A,2),(S,100)),frozenset((GI_S,VI_S,G,V0)),((KI,M("as",GI_S.id,"a",GI_S.id,5,"fresh",True)),(K,DS)))
X1,_=reset(XR,XS,30);X2,xa=receive(X1,XS);assert node(X2,K).proof and node(X2,K).state=="fresh"and not xa

# Unequal reset value: same identifier/generation, scoped edit at tau, no generation.
EY=ev(22,S,(K,N,BS),7,"edit",G.id,value="Y");EYV=ev(23,S,(K,N,BS),8,"validate",G.id,clears=((S,20),),target=EY.id);SY=replace(mS,value="Y",modified=7,origin=EY.id)
YS=Rep(S,23,((A,2),(S,23)),frozenset(set(JS)|{EY,EYV}),((K,SY),));Y1,ye=reset(RR,YS,40);ym=node(Y1,K)
assert ym.identifier==mR.identifier and ym.generation==G.id and ym.value=="Y"and ym.modified==40
assert len([e for e in ye if e.kind=="edit"and e.time==40])==1 and not any(e.kind=="add"for e in ye)
Y2,ye2=reset(Y1,YS,40);assert not ye2 and Y2==Y1
EMPTY=Rep(S,1,((S,1),),frozenset(),());YD,yde=reset(RR,EMPTY,40);assert node(YD,K)is None and mR.identifier in YD.retired and any(e.kind=="delete"for e in yde)
YREM,yre=reset(YD,YS,50);assert node(YREM,K).identifier!=mR.identifier and any(e.kind=="add"for e in yre)

# A negative target after a same-generation edit always gets a new post-edit barrier.
GH=gen(1,A,(K,N,BS),1,"X",(2,A));GHV=ev(2,A,(K,N,BS),2,"validate",GH.id);OLDH=ev(10,R,(K,N,BS),10,"invalidate",GH.id,"hard")
hardOld=Rep(R,10,((A,2),(R,10)),frozenset((GH,GHV,OLDH)),((K,M("hx",GH.id,"X",GH.id,1,"hard",False)),))
OLDV=ev(11,B,(K,N,BS),11,"validate",GH.id,clears=((R,10),));oldValidated=Rep(B,11,((A,2),(R,10),(B,11)),frozenset((GH,GHV,OLDH,OLDV)),((K,M("tx",GH.id,"X",GH.id,1,"fresh",True)),))
SYE=ev(20,S,(K,N,BS),20,"edit",GH.id,value="Y");SYH=ev(21,S,(K,N,BS),21,"invalidate",GH.id,"hard");hardTarget=Rep(S,21,((A,2),(S,21)),frozenset((GH,GHV,SYE,SYH)),((K,M("sy",GH.id,"Y",SYE.id,20,"hard",False)),))
hardReset,hardResetEvents=reset(hardOld,hardTarget,100);postHard=[e for e in hardResetEvents if e.kind=="invalidate"and e.mode=="hard"]
assert len(postHard)==1 and any(e.kind=="edit"and e.id<postHard[0].id for e in hardResetEvents)
hardRepeat,hardRepeatEvents=reset(hardReset,hardTarget,100);assert not hardRepeatEvents and hardRepeat==hardReset
hardDelayed,hardDelayedEvents=receive(hardReset,oldValidated);assert not hardDelayedEvents and node(hardDelayed,K).value=="Y"and node(hardDelayed,K).state=="hard"and postHard[0]in hardDelayed.journal

# Journal-soft authority on a zero-input node is operationally hard: no incoming
# proof exists for cache-only reuse.
ROOT_H=ev(30,A,(K,N,BS),30,"invalidate",GH.id,"hard");ROOT_V=ev(31,R,(K,N,BS),31,"validate",GH.id,clears=((A,30),));ROOT_S=ev(32,S,(K,N,BS),32,"invalidate",GH.id,"soft")
rootFresh=Rep(R,31,((A,30),(R,31)),frozenset((GH,GHV,ROOT_H,ROOT_V)),((K,M("rf",GH.id,"X",GH.id,1,"fresh",True)),))
rootHard=Rep(S,32,((A,30),(S,32)),frozenset((GH,GHV,ROOT_H,ROOT_S)),((K,M("rh",GH.id,"X",GH.id,1,"hard",False)),))
rootJoined,rootEvents=receive(rootFresh,rootHard,100);assert len(rootEvents)==1 and rootEvents[0].mode=="hard"and rootEvents[0].time==100 and node(rootJoined,K).state=="hard"
rootReverse,rootReverseEvents=receive(rootHard,rootJoined);assert not rootReverseEvents and rootEvents[0]in rootReverse.journal
rootSettled,rootSettledEvents=receive(rootJoined,rootHard);assert not rootSettledEvents and rootSettled==rootJoined

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

# A soft target after X->Y gets a new post-edit soft barrier; an old validation
# that cleared X's barrier cannot make Y fresh.
EX=ev(7,R,(KE,NE,BE),7,"edit",SGE.id,value="X");IX=ev(8,R,(KE,NE,BE),8,"invalidate",SGE.id,"soft",target=EX.id)
softOld=Rep(R,8,((A,6),(R,8)),frozenset(set(softR.journal)|{EX,IX}),tuple(sorted((*sroots,(KE,M("ox",SGE.id,"X",EX.id,7,"soft",True,((KI,"a"),(KD,"c"))))))))
XV=ev(9,B,(KE,NE,BE),9,"validate",SGE.id,clears=((R,8),),target=EX.id);softOldValidated=Rep(B,9,((A,6),(R,8),(B,9)),frozenset(set(softOld.journal)|{XV}),tuple(sorted((*sroots,(KE,M("tv",SGE.id,"X",EX.id,7,"fresh",True,((KI,"a"),(KD,"c"))))))))
SEY=ev(20,S,(KE,NE,BE),20,"edit",SGE.id,value="Y");SIY=ev(21,S,(KE,NE,BE),21,"invalidate",SGE.id,"soft",target=SEY.id)
softTarget=Rep(S,21,((A,6),(S,21)),frozenset(set(softR.journal)|{SEY,SIY}),tuple(sorted((*sroots,(KE,M("sy",SGE.id,"Y",SEY.id,20,"soft",True,((KI,"a"),(KD,"c"))))))))
assert validate_replica(softOld)and validate_replica(softOldValidated)and validate_replica(softTarget)
softEdited,softEditEvents=reset(softOld,softTarget,100);postSoft=[e for e in softEditEvents if e.kind=="invalidate"and e.mode=="soft"]
assert len(postSoft)==1 and any(e.kind=="edit"and e.id<postSoft[0].id for e in softEditEvents)
softEditedAgain,softEditedAgainEvents=reset(softEdited,softTarget,100);assert not softEditedAgainEvents and softEditedAgain==softEdited
softDelayed,softDelayedEvents=receive(softEdited,softOldValidated);assert not softDelayedEvents and node(softDelayed,KE).value=="Y"and node(softDelayed,KE).state=="soft"and postSoft[0]in softDelayed.journal

# Losing the reusable proof of stale-soft state is a genuine local hardening;
# reverse receive imports that precise barrier silently.
SIB=ev(90,S,(KI,NI,BI),10,"edit",SGI.id,value="b");SID=ev(91,S,(KD,ND,BD),0,"edit",SGD.id,value="d2");SIBV=ev(92,S,(KI,NI,BI),92,"validate",SGI.id,target=SIB.id);SIDV=ev(93,S,(KD,ND,BD),93,"validate",SGD.id,target=SID.id)
changedRoots=((KI,M("si2",SGI.id,"b",SIB.id,10,"fresh",True)),(KD,M("sd2",SGD.id,"d2",SID.id,0,"fresh",True)))
changedDerived=M("se2",SGE.id,"d",SGE.id,1,"soft",True,((KI,"b"),(KD,"d2")))
changedSoft=Rep(S,93,((A,6),(S,93)),frozenset(set(softR.journal)|{ISS,SIB,SID,SIBV,SIDV}),tuple(sorted((*changedRoots,(KE,changedDerived)))))
assert validate_replica(changedSoft)
hardened,hardEvents=receive(Soft1,changedSoft,100);assert len(hardEvents)==1 and hardEvents[0].mode=="hard"and hardEvents[0].time==100 and node(hardened,KE).state=="hard"and node(hardened,KE).modified==1 and not node(hardened,KE).proof
reverse,reverseEvents=receive(changedSoft,hardened);assert not reverseEvents and node(reverse,KE).state=="hard"and hardEvents[0] in reverse.journal and hardEvents[0].time==100

# Hard source resets fresh receiver: retained local hard assertion, no proof, later no echo.
ISH=ev(22,S,(K,N,BS),22,"invalidate",G.id,"hard");hardS=Rep(S,22,((A,2),(S,22)),frozenset(set(JS)|{ISH}),((K,replace(mS,state="hard",proof=False)),))
assert validate_replica(hardS)
H1,he=reset(RR,hardS,30);assert any(e.kind=="invalidate"and e.mode=="hard"for e in he)and not node(H1,K).proof
H2,ha=receive(H1,hardS);assert node(H2,K).state=="hard"and not ha

# Observed prefix clears delayed A40 but not unseen A51.
G50=gen(1,B,(KD,ND,BD),1,"z",(2,B));GV=ev(2,B,(KD,ND,BD),2,"validate",G50.id)
I40=ev(40,A,(KD,ND,BD),10,"invalidate",G50.id,"hard");Vreset=ev(60,R,(KD,ND,BD),20,"validate",G50.id,clears=((A,50),(B,2)))
I45=ev(45,A,(KD,ND,BD),15,"invalidate",G50.id,"hard");coveredHistory=(G50,GV,I40,I45,Vreset)
assert covers(Vreset,I40) and I40 not in compact(coveredHistory) and I45 in compact(coveredHistory)
I41=ev(41,A,(KD,ND,BD),21,"invalidate",G50.id,"soft");assert covers(Vreset,I41)
I51=ev(51,A,(KD,ND,BD),21,"invalidate",G50.id,"hard");assert not covers(Vreset,I51)
assert fresh((G50,GV,Vreset,I40),KD,G50.id)and hard((G50,GV,Vreset,I51),KD,G50.id)
Vthrough40=ev(61,R,(KD,ND,BD),22,"validate",G50.id,clears=((A,40),(B,2)));assert covers(Vthrough40,I40)and not covers(Vthrough40,I41)
# Future union with delayed covered evidence agrees around compaction.
CA=frozenset(coveredHistory);CB=frozenset((G50,GV,I40,I51))
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

# Reset correspondence makes an authoritative hard semantic copy stable without
# importing source history or relaxing arbitrary unsupported-cache fallback.
HM=ev(7,S,(KE,NE,BE),7,"invalidate",GE.id,"hard",target=GE.id);hardMultiS=Rep(S,7,((A,6),(S,7)),frozenset(set(baseJ)|{HM}),tuple(sorted((*roots,(KE,replace(derived,identifier="sd",state="hard",proof=False,inputs=()))))))
rootsOnly=Rep(R,0,((A,4),),frozenset((GI,GIV,GD,GDV)),tuple(sorted(roots)))
hardAdded,hardAddedEvents=reset(rootsOnly,hardMultiS,100);assert node(hardAdded,KE).state=="hard"and any(e.lineage and e.lineage[1:]==(GE.id,GE.id)for e in hardAddedEvents)
hardAddedSync,hardAddedSyncEvents=receive(hardAdded,hardMultiS);assert not hardAddedSyncEvents and sem(hardAddedSync)==sem(hardAdded)
hardAddedAgain,hardAddedAgainEvents=reset(hardAdded,hardMultiS,100);assert not hardAddedAgainEvents and hardAddedAgain==hardAdded
assert any(e.lineage for e in compact(hardAdded.journal))

# Same-generation changed and equal-value/different-revision hard resets also
# retain their receiver value through unchanged-source sync.
RX=ev(8,R,(KE,NE,BE),8,"edit",GE.id,value="X");RHX=ev(9,R,(KE,NE,BE),9,"invalidate",GE.id,"hard",target=RX.id)
sameR=Rep(R,9,((A,6),(R,9)),frozenset(set(baseJ)|{RX,RHX}),tuple(sorted((*roots,(KE,M("rx",GE.id,"X",RX.id,8,"hard",False))))))
SD=ev(10,S,(KE,NE,BE),10,"edit",GE.id,value="d2");SHD=ev(11,S,(KE,NE,BE),11,"invalidate",GE.id,"hard",target=SD.id)
sameS=Rep(S,11,((A,6),(S,11)),frozenset(set(baseJ)|{SD,SHD}),tuple(sorted((*roots,(KE,M("sd2",GE.id,"d2",SD.id,10,"hard",False))))))
changedReset,changedResetEvents=reset(sameR,sameS,100);changedSync,changedSyncEvents=receive(changedReset,sameS);assert not changedSyncEvents and sem(changedSync)==sem(changedReset)
ER=ev(12,R,(KE,NE,BE),12,"edit",GE.id,value="equal");EHR=ev(13,R,(KE,NE,BE),13,"invalidate",GE.id,"hard",target=ER.id)
ES=ev(14,S,(KE,NE,BE),14,"edit",GE.id,value="equal");EHS=ev(15,S,(KE,NE,BE),15,"invalidate",GE.id,"hard",target=ES.id)
equalR=Rep(R,13,((A,6),(R,13)),frozenset(set(baseJ)|{ER,EHR}),tuple(sorted((*roots,(KE,M("er",GE.id,"equal",ER.id,12,"hard",False))))))
equalS=Rep(S,15,((A,6),(S,15)),frozenset(set(baseJ)|{ES,EHS}),tuple(sorted((*roots,(KE,M("es",GE.id,"equal",ES.id,14,"hard",False))))))
equalReset,equalResetEvents=reset(equalR,equalS,100);assert not any(e.kind=="edit"for e in equalResetEvents)
equalSync,equalSyncEvents=receive(equalReset,equalS);assert not equalSyncEvents and sem(equalSync)==sem(equalReset)
UNSEEN=ev(200,S,(KE,NE,BE),200,"edit",GE.id,value="future");UNSEEN_H=ev(201,S,(KE,NE,BE),201,"invalidate",GE.id,"hard",target=UNSEEN.id)
unseenS=Rep(S,201,((A,6),(S,201)),frozenset(set(baseJ)|{UNSEEN,UNSEEN_H}),tuple(sorted((*roots,(KE,M("future",GE.id,"future",UNSEEN.id,200,"hard",False))))))
assert compact(compact(equalReset.journal)|unseenS.journal)==compact(equalReset.journal|unseenS.journal)
unseenResult,unseenEvents=receive(equalReset,unseenS,300);assert node(unseenResult,KE)is None and any(e.kind=="delete"for e in unseenEvents)

# Derived selection classifies candidates before revision ordering.
ONE={KI:(),KE:(KI,),KD:(),K:()}
OI=gen(1,A,(KI,NI,BI),1,"a",(2,A));OIV=ev(2,A,(KI,NI,BI),2,"validate",OI.id)
OD=gen(3,A,(KE,NE,BE),10,"old",(4,A));ODV=ev(4,A,(KE,NE,BE),11,"validate",OD.id);oneBase=frozenset((OI,OIV,OD,ODV))
oneRoots=((KI,M("ia",OI.id,"a",OI.id,1,"fresh",True)),);oneOld=M("old-id",OD.id,"old",OD.id,10,"fresh",True,((KI,"a"),))
oneR=Rep(R,0,((A,4),),oneBase,tuple(sorted((*oneRoots,(KE,oneOld)))))
ONE_NEW=ev(20,S,(KE,NE,BE),20,"edit",OD.id,value="new");ONE_HARD=ev(21,S,(KE,NE,BE),21,"invalidate",OD.id,"hard",target=ONE_NEW.id)
oneUnsupported=Rep(S,21,((A,4),(S,21)),frozenset(set(oneBase)|{ONE_NEW,ONE_HARD}),tuple(sorted((*oneRoots,(KE,M("new-id",OD.id,"new",ONE_NEW.id,20,"hard",False))))))
olderCoherent,olderEvents=receive(oneR,oneUnsupported,schema=ONE);assert not olderEvents and node(olderCoherent,KE).value=="old"and node(olderCoherent,KE).state=="fresh"and node(olderCoherent,KE).proof
# A generation-wide explicit invalidate still applies to selected old.
EXPLICIT=ev(22,S,(KE,NE,BE),22,"invalidate",OD.id,"hard");explicitSource=replace(oneUnsupported,clock=22,coverage=((A,4),(S,22)),journal=frozenset(set(oneUnsupported.journal)|{EXPLICIT}))
explicitMerged,explicitEvents=receive(oneR,explicitSource,schema=ONE);assert not explicitEvents and node(explicitMerged,KE).value=="old"and node(explicitMerged,KE).state=="hard"
# Two coherent candidates choose the greatest coherent revision.
oneNew=M("new-id",OD.id,"new",ONE_NEW.id,20,"fresh",True,((KI,"a"),))
ONE_NEW_V=ev(22,S,(KE,NE,BE),22,"validate",OD.id,target=ONE_NEW.id);oneNewCoherent=Rep(S,22,((A,4),(S,22)),frozenset(set(oneBase)|{ONE_NEW,ONE_NEW_V}),tuple(sorted((*oneRoots,(KE,oneNew)))))
newerCoherent,newerEvents=receive(oneR,oneNewCoherent,schema=ONE);assert not newerEvents and node(newerCoherent,KE).value=="new"and node(newerCoherent,KE).proof
# One-input no-coherent fallback keeps the greatest admissible revision.
ONE_RH=ev(11,R,(KE,NE,BE),11,"invalidate",OD.id,"hard");oneRHard=Rep(R,11,((A,4),(R,11)),frozenset(set(oneBase)|{ONE_RH}),tuple(sorted((*oneRoots,(KE,replace(oneOld,state="hard",proof=False))))))
oneFallback,oneFallbackEvents=receive(oneRHard,oneUnsupported,schema=ONE);assert not oneFallbackEvents and node(oneFallback,KE).value=="new"and node(oneFallback,KE).state=="hard"
# Equal selected revision under two identifiers uses least canonical identifier.
oneTwin=replace(oneR,fp=S,nodes=tuple(sorted((*oneRoots,(KE,replace(oneOld,identifier="a-id"))))))
oneTie,oneTieEvents=receive(oneR,oneTwin,schema=ONE);assert not oneTieEvents and node(oneTie,KE).identifier=="a-id"

# Stale final inputs propagate upward as value-specific soft assertions while
# coherent reusable proofs remain.
AIH=ev(30,S,(KI,NI,BI),30,"invalidate",OI.id,"hard");inputHard=Rep(S,30,((A,4),(S,30)),frozenset((OI,OIV,AIH)),((KI,M("ih",OI.id,"a",OI.id,1,"hard",False)),))
upSoft,upSoftEvents=receive(oneR,inputHard,100,schema=ONE);assert node(upSoft,KI).state=="hard"and node(upSoft,KE).state=="soft"and node(upSoft,KE).proof
assert len(upSoftEvents)==1 and upSoftEvents[0].mode=="soft"and upSoftEvents[0].target==OD.id and upSoftEvents[0].time==100
upReverse,upReverseEvents=receive(inputHard,upSoft,schema=ONE);assert not upReverseEvents and upSoftEvents[0]in upReverse.journal
upSettled,upSettledEvents=receive(upSoft,inputHard,schema=ONE);assert not upSettledEvents and upSettled==upSoft
# Revalidating the input unchanged leaves D cache-revalidatable rather than hard.
AIV=ev(31,S,(KI,NI,BI),31,"validate",OI.id,clears=((S,30),));inputFreshAgain=Rep(S,31,((A,4),(S,31)),frozenset((OI,OIV,AIH,AIV)),((KI,M("if",OI.id,"a",OI.id,1,"fresh",True)),))
afterInputFresh,afterInputFreshEvents=receive(upSoft,inputFreshAgain,schema=ONE);assert not afterInputFreshEvents and node(afterInputFresh,KE).state=="soft"and node(afterInputFresh,KE).proof

EIB=ev(100,S,(KI,NI,BI),10,"edit",GI.id,value="b");EIBV=ev(101,S,(KI,NI,BI),101,"validate",GI.id,target=EIB.id)
DRIGHT=Rep(S,101,((A,4),(S,101)),frozenset((GI,GIV,GD,GDV,EIB,EIBV)),((KI,M("i2",GI.id,"b",EIB.id,10,"fresh",True)),(KD,roots[1][1])))
assert validate_replica(DL)and validate_replica(DRIGHT)
DM,dm_events=receive(DL,DRIGHT,100);assert node(DM,KE)is None and len(dm_events)==1 and dm_events[0].kind=="delete"and dm_events[0].key==KE and dm_events[0].time==100
# Same semantic input at a different revision preserves real multi-input proof; duplicate KI is collapsed.
EIA=ev(100,S,(KI,NI,BI),10,"edit",GI.id,value="a");EIAV=ev(101,S,(KI,NI,BI),101,"validate",GI.id,target=EIA.id)
DEQUAL=Rep(S,101,((A,4),(S,101)),frozenset((GI,GIV,GD,GDV,EIA,EIAV)),((KI,M("i2",GI.id,"a",EIA.id,10,"fresh",True)),(KD,roots[1][1])))
DEM,de_events=receive(DL,DEQUAL);assert node(DEM,KE).proof and node(DEM,KE).state=="fresh"and not de_events and len(node(DEM,KE).inputs)==2 and node(DEM,KI).modified==10

# Multi-input different unsupported revisions delete; the same revision case is
# retained and hardened by the stale-soft proof-loss trace above.
MER=ev(10,R,(KE,NE,BE),10,"edit",GE.id,value="old");MHR=ev(11,R,(KE,NE,BE),11,"invalidate",GE.id,"hard")
MES=ev(20,S,(KE,NE,BE),20,"edit",GE.id,value="new");MHS=ev(21,S,(KE,NE,BE),21,"invalidate",GE.id,"hard")
multiR=Rep(R,11,((A,6),(R,11)),frozenset(set(baseJ)|{MER,MHR}),tuple(sorted((*roots,(KE,M("mr",GE.id,"old",MER.id,10,"hard",False))))))
multiS=Rep(S,21,((A,6),(S,21)),frozenset(set(baseJ)|{MES,MHS}),tuple(sorted((*roots,(KE,M("ms",GE.id,"new",MES.id,20,"hard",False))))))
multiDeleted,multiDeleteEvents=receive(multiR,multiS,100);assert node(multiDeleted,KE)is None and len(multiDeleteEvents)==1 and multiDeleteEvents[0].kind=="delete"

# Joined-history provenance obsoletes a lower same-author value head.
PO10=ev(10,B,(KE,NE,BE),10,"edit",GE.id,value="old");PO10V=ev(11,B,(KE,NE,BE),11,"validate",GE.id,target=PO10.id);PO20=ev(20,B,(KE,NE,BE),5,"edit",GE.id,value="canonical");PO20V=ev(21,B,(KE,NE,BE),21,"validate",GE.id,target=PO20.id)
provOld=M("pr",GE.id,"old",PO10.id,10,"fresh",True,((KI,"a"),(KD,"c")));provNew=M("ps",GE.id,"canonical",PO20.id,5,"fresh",True,((KI,"a"),(KD,"c")))
provR=Rep(R,0,((A,6),(B,11)),frozenset(set(baseJ)|{PO10,PO10V}),tuple(sorted((*roots,(KE,provOld)))))
provS=Rep(S,0,((A,6),(B,21)),frozenset(set(baseJ)|{PO10,PO10V,PO20,PO20V}),tuple(sorted((*roots,(KE,provNew)))))
provMerged,provEvents=receive(provR,provS);assert not provEvents and node(provMerged,KE).value=="canonical"and node(provMerged,KE).origin==PO20.id

# A value-specific soft barrier for losing Y does not stale coherent selected X.
XRVAL=ev(30,R,(KE,NE,BE),10,"edit",GE.id,value="X");XRVALV=ev(31,R,(KE,NE,BE),31,"validate",GE.id,target=XRVAL.id)
Xnode=M("x",GE.id,"X",XRVAL.id,10,"fresh",True,((KI,"a"),(KD,"c")));Xrep=Rep(R,31,((A,6),(R,31)),frozenset(set(baseJ)|{XRVAL,XRVALV}),tuple(sorted((*roots,(KE,Xnode)))))
SBI=ev(31,S,(KI,NI,BI),0,"edit",GI.id,value="b");SBD=ev(32,S,(KD,ND,BD),0,"edit",GD.id,value="d2");SBIV=ev(35,S,(KI,NI,BI),35,"validate",GI.id,target=SBI.id);SBDV=ev(36,S,(KD,ND,BD),36,"validate",GD.id,target=SBD.id);SYVAL=ev(33,S,(KE,NE,BE),20,"edit",GE.id,value="Y");SYSoft=ev(34,S,(KE,NE,BE),21,"invalidate",GE.id,"soft",target=SYVAL.id)
yRoots=((KI,M("yb",GI.id,"b",SBI.id,0,"fresh",True)),(KD,M("yd",GD.id,"d2",SBD.id,0,"fresh",True)))
Ynode=M("y",GE.id,"Y",SYVAL.id,20,"soft",True,((KI,"b"),(KD,"d2")));Yrep=Rep(S,36,((A,6),(S,36)),frozenset(set(baseJ)|{SBI,SBD,SBIV,SBDV,SYVAL,SYSoft}),tuple(sorted((*yRoots,(KE,Ynode)))))
xyMerged,xyEvents=receive(Xrep,Yrep);assert not xyEvents and node(xyMerged,KE).value=="X"and node(xyMerged,KE).state=="fresh"and node(xyMerged,KE).proof
assert SYSoft in compact(xyMerged.journal)and any(a=="invalidate"for a,_ in query(xyMerged.journal))
SYClear=ev(37,S,(KE,NE,BE),37,"validate",GE.id,clears=((S,34),),target=SYVAL.id)
assert fresh(set(Yrep.journal)|{SYClear},KE,GE.id,SYVAL.id)
assert compact(compact(Xrep.journal)|set(Yrep.journal)|{SYClear})==compact(set(Xrep.journal)|set(Yrep.journal)|{SYClear})
assert journal_projection(set(Xrep.journal)|set(Yrep.journal)|{SYClear})==journal_projection(compact(set(Xrep.journal)|set(Yrep.journal)|{SYClear}))
# Positive freshness is origin-scoped: a validation for Y cannot validate X,
# including after a generation-wide barrier; X's own validation can.
XBAR=ev(40,R,(KE,NE,BE),40,"invalidate",GE.id,"hard",target=XRVAL.id)
YV=ev(41,S,(KE,NE,BE),41,"validate",GE.id,clears=((R,40),),target=SYVAL.id)
assert not fresh(set(Xrep.journal)|{XBAR,YV},KE,GE.id,XRVAL.id)
GW=ev(42,R,(KE,NE,BE),42,"invalidate",GE.id,"hard");assert not fresh(set(Xrep.journal)|{GW,YV},KE,GE.id,XRVAL.id)
XV2=ev(43,S,(KE,NE,BE),43,"validate",GE.id,clears=((R,42),),target=XRVAL.id)
assert fresh(set(Xrep.journal)|{XBAR,GW,XV2},KE,GE.id,XRVAL.id)
assert not fresh(set(baseJ)|{XRVAL},KE,GE.id,XRVAL.id) and fresh(set(baseJ)|{XRVAL,XRVALV},KE,GE.id,XRVAL.id)

# A reset lineage absorbs the consumed source prefix but activates later source
# edits, deletes, and rematerializations even below the receiver Lamport ID.
LG=gen(10,S,(K,N,BS),10,"A",(20,S));LGV=ev(20,S,(K,N,BS),20,"validate",LG.id)
lineageS0=Rep(S,20,((S,20),),frozenset((LG,LGV)),((K,M("ls",LG.id,"A",LG.id,10,"fresh",True)),))
lineageR0=Rep(R,100,((R,100),),frozenset(),())
lineageR1,lineageResetEvents=reset(lineageR0,lineageS0,100)
assert node(lineageR1,K).value=="A"and node(lineageR1,K).generation[0]>100
lineageAgain,lineageAgainEvents=reset(lineageR1,lineageS0,100);assert not lineageAgainEvents and lineageAgain==lineageR1
LE=ev(21,S,(K,N,BS),101,"edit",LG.id,value="B");LEV=ev(22,S,(K,N,BS),102,"validate",LG.id,target=LE.id)
lineageS1=Rep(S,22,((S,22),),frozenset((LG,LGV,LE,LEV)),((K,M("ls",LG.id,"B",LE.id,101,"fresh",True)),))
lineageEdited,lineageEditEvents=receive(lineageR1,lineageS1);assert not lineageEditEvents and node(lineageEdited,K).value=="B"and node(lineageEdited,K).generation==LG.id
# The same activation applies when reset preserves a numerically greater,
# already-present receiver generation and equal value.
RG=gen(100,R,(K,N,BS),10,"A",(101,R));RGV=ev(101,R,(K,N,BS),11,"validate",RG.id)
lineagePresentR=Rep(R,101,((R,101),),frozenset((RG,RGV)),((K,M("lr",RG.id,"A",RG.id,10,"fresh",True)),))
lineagePresentReset,presentResetEvents=reset(lineagePresentR,lineageS0,100);assert not any(e.kind in("add","edit")for e in presentResetEvents)
lineagePresentEdited,presentEditEvents=receive(lineagePresentReset,lineageS1);assert not presentEditEvents and node(lineagePresentEdited,K).value=="B"
LD=dele(21,S,(K,N,BS),101);lineageDeletedS=Rep(S,21,((S,21),),frozenset((LG,LGV,LD)),())
lineageDeleted,lineageDeleteEvents=receive(lineageR1,lineageDeletedS);assert not lineageDeleteEvents and node(lineageDeleted,K)is None
LR=gen(22,S,(K,N,BS),102,"C",(23,S));LRV=ev(23,S,(K,N,BS),103,"validate",LR.id)
lineageRematS=Rep(S,23,((S,23),),frozenset((LG,LGV,LD,LR,LRV)),((K,M("ls2",LR.id,"C",LR.id,102,"fresh",True)),))
lineageRemat,lineageRematEvents=receive(lineageR1,lineageRematS);assert not lineageRematEvents and node(lineageRemat,K).value=="C"and node(lineageRemat,K).generation==LR.id
assert compact(compact(lineageR1.journal)|lineageS1.journal)==compact(lineageR1.journal|lineageS1.journal)
# Lineage cutoffs are causal vectors, not source-container identity. A different
# author above its consumed coordinate activates edits/deletes, including when
# the event is carried by a third host; a missing coordinate means zero.
lineageVectorS0=replace(lineageS0,coverage=((B,10),(S,20)))
lineageVectorR,lineageVectorEvents=reset(lineageR0,lineageVectorS0,100)
assert ph(lineageVectorR.journal|lineageVectorS0.journal,K).id==node(lineageVectorR,K).generation
BEDIT=ev(11,B,(K,N,BS),103,"edit",LG.id,value="B-author");BEV=ev(12,B,(K,N,BS),104,"validate",LG.id,target=BEDIT.id)
lineageB=Rep(B,12,((B,12),(S,20)),frozenset((LG,LGV,BEDIT,BEV)),((K,M("lb",LG.id,"B-author",BEDIT.id,103,"fresh",True)),))
fromB,fromBEvents=receive(lineageVectorR,lineageB);assert not fromBEvents and node(fromB,K).value=="B-author"
carrier=replace(lineageB,fp=C,clock=0,coverage=((B,12),(S,20)))
fromCarrier,carrierEvents=receive(lineageVectorR,carrier);assert not carrierEvents and node(fromCarrier,K).value=="B-author"
BDEL=dele(11,B,(K,N,BS),103);lineageBDeleted=Rep(B,11,((B,11),(S,20)),frozenset((LG,LGV,BDEL)),())
fromBDelete,bDeleteEvents=receive(lineageVectorR,lineageBDeleted);assert not bDeleteEvents and node(fromBDelete,K)is None
# Scoped post-cutoff events activate GS against the reset anchor but never become
# synthetic presence coordinates. A concurrent delete still orders after GS.
SDEL21=dele(21,S,(K,N,BS),105);BEDIT30=ev(30,B,(K,N,BS),106,"edit",LG.id,value="late");BVAL31=ev(31,B,(K,N,BS),107,"validate",LG.id,target=BEDIT30.id);BINV32=ev(32,B,(K,N,BS),108,"invalidate",LG.id,"hard",target=BEDIT30.id)
for scoped in (BEDIT30,BVAL31,BINV32):assert ph(lineageVectorR.journal|{LG,LGV,SDEL21,BEDIT30,scoped},K)==SDEL21
assert ph(lineageVectorR.journal|{LG,LGV,BEDIT30},K).id==LG.id
missingBReset,_=reset(lineageR0,lineageS0,100);assert dict(next(e.lineage[0]for e in missingBReset.journal if e.lineage)).get(B,0)==0
B1E=ev(1,B,(K,N,BS),103,"edit",LG.id,value="missing-author");B2V=ev(2,B,(K,N,BS),104,"validate",LG.id,target=B1E.id)
missingB=Rep(B,2,((B,2),(S,20)),frozenset((LG,LGV,B1E,B2V)),((K,M("mb",LG.id,"missing-author",B1E.id,103,"fresh",True)),))
missingLive,missingEvents=receive(missingBReset,missingB);assert not missingEvents and node(missingLive,K).value=="missing-author"

# An absent reset target carries its observation vector on the real public
# delete. Post-cutoff rematerialization by any author remains live.
absentSource=Rep(S,20,((B,10),(S,20)),frozenset(),())
absentReset,absentResetEvents=reset(lineagePresentR,absentSource,100);absentDelete=next(e for e in absentResetEvents if e.kind=="delete")
assert absentDelete.lineage==(vmax(lineagePresentR.coverage,absentSource.coverage),None,None)
absentAgain,absentAgainEvents=reset(absentReset,absentSource,100);assert not absentAgainEvents and absentAgain==absentReset
SADD=gen(21,S,(K,N,BS),101,"after-absent",(22,S));SADDV=ev(22,S,(K,N,BS),102,"validate",SADD.id)
sameAuthorRemat=Rep(S,22,((B,10),(S,22)),frozenset((SADD,SADDV)),((K,M("sar",SADD.id,"after-absent",SADD.id,101,"fresh",True)),))
sameAuthorLive,sameAuthorEvents=receive(absentReset,sameAuthorRemat);assert not sameAuthorEvents and node(sameAuthorLive,K).value=="after-absent"
BADD=gen(12,B,(K,N,BS),101,"other-remat",(13,B));BADDV=ev(13,B,(K,N,BS),102,"validate",BADD.id)
otherAuthorRemat=Rep(B,13,((B,13),(S,20)),frozenset((BADD,BADDV)),((K,M("oar",BADD.id,"other-remat",BADD.id,101,"fresh",True)),))
otherAuthorLive,otherAuthorEvents=receive(absentReset,otherAuthorRemat);assert not otherAuthorEvents and node(otherAuthorLive,K).value=="other-remat"

# Absent-to-absent reset records internal observation, not a fake public delete.
OLDDEL=dele(100,R,(K,N,BS),90);alreadyAbsent=Rep(R,100,((R,100),),frozenset((OLDDEL,)),())
OLDADD=gen(5,S,(K,N,BS),5,"old",(6,S));OLDADDV=ev(6,S,(K,N,BS),6,"validate",OLDADD.id);OLDDEL_S=dele(10,S,(K,N,BS),10)
absentHistory=Rep(S,10,((S,10),),frozenset((OLDADD,OLDADDV,OLDDEL_S)),())
observedAbsent,absentObservationEvents=reset(alreadyAbsent,absentHistory,110)
assert [e.kind for e in absentObservationEvents]==["observe"]and not query(observedAbsent.journal,((R,100),(S,10)))
assert ph(observedAbsent.journal|absentHistory.journal,K)==OLDDEL
FIRSTADD=gen(11,S,(K,N,BS),111,"first",(12,S));FIRSTADDV=ev(12,S,(K,N,BS),112,"validate",FIRSTADD.id)
firstSource=Rep(S,12,((S,12),),frozenset((FIRSTADD,FIRSTADDV)),((K,M("first",FIRSTADD.id,"first",FIRSTADD.id,111,"fresh",True)),))
firstLive,firstEvents=receive(observedAbsent,firstSource);assert not firstEvents and node(firstLive,K).value=="first"
observedAbsentAgain,absentObservationAgain=reset(observedAbsent,absentHistory,110);assert not absentObservationAgain and observedAbsentAgain==observedAbsent
compactedObservation=compact(observedAbsent.journal);assert any(e.kind=="observe"for e in compactedObservation)and journal_projection(compactedObservation)==journal_projection(observedAbsent.journal)

# Concurrent observations for one absence anchor join componentwise; numeric
# carrier order is not causality, including equal sequences from two authors.
CRA=observe(101,R,(K,N,BS),101,OLDDEL.id,(((A,50),),None,None));CRB=observe(200,S,(K,N,BS),102,OLDDEL.id,(((B,60),),None,None));CREQ=observe(101,C,(K,N,BS),103,OLDDEL.id,(((B,60),),None,None))
concurrentObs=frozenset((OLDDEL,CRA,CRB,CREQ));assert valid(concurrentObs)
AGO=gen(49,A,(K,N,BS),49,"a-old",(50,A));AGOV=ev(50,A,(K,N,BS),50,"validate",AGO.id);assert ph(concurrentObs|{AGO,AGOV},K)==OLDDEL
BGO=gen(59,B,(K,N,BS),59,"b-old",(60,B));BGOV=ev(60,B,(K,N,BS),60,"validate",BGO.id);assert ph(concurrentObs|{BGO,BGOV},K)==OLDDEL
AGNEW=gen(51,A,(K,N,BS),51,"a-new",(52,A));AGNEWV=ev(52,A,(K,N,BS),52,"validate",AGNEW.id);assert ph(concurrentObs|{AGNEW,AGNEWV},K).id==AGNEW.id
BGNEW=gen(61,B,(K,N,BS),61,"b-new",(62,B));BGNEWV=ev(62,B,(K,N,BS),62,"validate",BGNEW.id);assert ph(concurrentObs|{BGNEW,BGNEWV},K).id==BGNEW.id
assert merge(concurrentObs,concurrentObs)==compact(concurrentObs)and compact(compact(concurrentObs)|{AGNEW,AGNEWV})==compact(concurrentObs|{AGNEW,AGNEWV})

# A later authoritative reset extends the old vector with newly observed B11,
# while exact unchanged repetition remains silent and B12 remains future-live.
resetAfterB11,resetAfterB11Events=reset(fromBDelete,lineageVectorS0,110);extended=next(e.lineage[0]for e in resetAfterB11Events if e.lineage)
assert dict(extended)[B]>=11 and node(resetAfterB11,K).value=="A"
resetAfterB11Again,repeatAfterB11=reset(resetAfterB11,lineageVectorS0,110);assert not repeatAfterB11 and resetAfterB11Again==resetAfterB11
BDEL12=dele(12,B,(K,N,BS),111);futureB12=Rep(B,12,((B,12),(S,20)),frozenset((LG,LGV,BDEL12)),())
afterFutureB12,futureB12Events=receive(resetAfterB11,futureB12);assert not futureB12Events and node(afterFutureB12,K)is None
# A different equal source origin with lower B coverage cannot regress the old
# same-anchor vector.
ALTEDIT=ev(21,S,(K,N,BS),109,"edit",LG.id,value="A");ALTVAL=ev(22,S,(K,N,BS),110,"validate",LG.id,target=ALTEDIT.id)
altSource=Rep(S,22,((S,22),),frozenset((LG,LGV,ALTEDIT,ALTVAL)),((K,M("alt",LG.id,"A",ALTEDIT.id,109,"fresh",True)),))
altReset,altResetEvents=reset(lineageVectorR,altSource,120);assert dict(next(e.lineage[0]for e in altResetEvents if e.lineage))[B]>=10

# Idempotence bookkeeping is key/anchor-local: unrelated reset metadata cannot
# hide genuine K delete/rematerialize history from the next reset.
KDEL150=dele(150,R,(K,N,BS),130);KGEN151=gen(151,R,(K,N,BS),131,"A",(152,R));KGENV152=ev(152,R,(K,N,BS),132,"validate",KGEN151.id)
LDEL149=dele(149,R,(KI,NI,BI),129);LOBS200=observe(200,R,(KI,NI,BI),140,LDEL149.id,(((R,149),),None,None))
returnedK=Rep(R,200,((R,200),(S,20)),frozenset(set(lineageR1.journal)|{KDEL150,KGEN151,KGENV152,LDEL149,LOBS200}),((K,M("returned",KGEN151.id,"A",KGEN151.id,131,"fresh",True)),))
resetReturned,returnedEvents=reset(returnedK,lineageS0,210);returnedLineage=next(e.lineage[0]for e in returnedEvents if e.key==K and e.lineage)
assert dict(returnedLineage)[R]>=152 and node(resetReturned,K).value=="A"
resetReturnedAgain,returnedAgainEvents=reset(resetReturned,lineageS0,210);assert not returnedAgainEvents and resetReturnedAgain==resetReturned
FUTUREDEL=dele(1,B,(K,N,BS),211);assert ph(resetReturned.journal|{FUTUREDEL},K)==FUTUREDEL
assert compact(compact(resetReturned.journal)|{FUTUREDEL})==compact(resetReturned.journal|{FUTUREDEL})

# Compaction retains the bridge while causal presence is absent even after a
# newer non-certificate validation displaces it as the polling maximum.
anchor=node(lineageVectorR,K);NV=ev(103,R,(K,N,BS),103,"validate",anchor.generation,clears=carry_prefix(lineageVectorR.journal,R,K,anchor.generation,anchor.origin,((R,102),)),target=anchor.origin)
withNewValidation=add_events(lineageVectorR,(NV,));deletedBridge,_=receive(withNewValidation,lineageBDeleted)
compactedAbsent=compact(deletedBridge.journal);retainedBridge=next(e for e in compactedAbsent if e.lineage);assert retainedBridge.lineage[0]==next(e.lineage[0]for e in deletedBridge.journal if e.lineage)and journal_projection(deletedBridge.journal)==journal_projection(compactedAbsent)
assert compact(compactedAbsent|otherAuthorRemat.journal)==compact(deletedBridge.journal|otherAuthorRemat.journal)

# Validation applicability is value-specific, while an author's causal-prefix
# knowledge is monotone across edits in the same generation.
KDX,NDX,BDX=addr(1);CK=gen(1,A,(KDX,NDX,BDX),1,"X",(2,A));CKV=ev(2,A,(KDX,NDX,BDX),2,"validate",CK.id)
VX=ev(10,R,(KDX,NDX,BDX),10,"validate",CK.id,clears=((S,100),),target=CK.id)
YE=ev(11,R,(KDX,NDX,BDX),11,"edit",CK.id,value="Y");VY=ev(12,R,(KDX,NDX,BDX),12,"validate",CK.id,clears=carry_prefix((CK,CKV,VX,YE),R,KDX,CK.id,YE.id),target=YE.id)
crossOrigin=frozenset((CK,CKV,VX,YE,VY));assert valid(crossOrigin)and dict(VY.clears)[S]==100 and not eff(VY,crossOrigin,KDX,CK.id,False,CK.id)
OLDGW=ev(90,S,(KDX,NDX,BDX),90,"invalidate",CK.id,"hard");assert fresh(set(crossOrigin)|{OLDGW},KDX,CK.id,YE.id)
OLDX=ev(90,S,(KDX,NDX,BDX),90,"invalidate",CK.id,"hard",target=CK.id);assert fresh(set(crossOrigin)|{OLDX},KDX,CK.id,YE.id)
NEWGW=ev(101,S,(KDX,NDX,BDX),101,"invalidate",CK.id,"hard");assert hard(set(crossOrigin)|{NEWGW},KDX,CK.id,YE.id)
assert journal_projection(crossOrigin)==journal_projection(compact(crossOrigin))and VX in compact(crossOrigin)and VY in compact(crossOrigin)
# Causal coverage and exact semantic correspondence are independent. Only exact
# compared pairs authorize unsupported-cache retention.
exactCert=next(e for e in hardAdded.journal if e.lineage);receiverCache=node(hardAdded,KE);sourceCache=node(hardMultiS,KE)
assert reset_lineage_covers(hardAdded.journal,receiverCache,sourceCache)
unrelated=M("unrelated",(40,B),"Y",(50,B),50,"hard",False)
assert not reset_lineage_covers(hardAdded.journal,receiverCache,unrelated)
OTHERPAIR=((30,S),(31,S));exact2=replace(exactCert,sequence=exactCert.sequence+100,author=C,lineage=(exactCert.lineage[0],*OTHERPAIR))
exactHistory=frozenset(set(hardAdded.journal)|{exact2});assert valid(exactHistory)and reset_lineage_covers(exactHistory,receiverCache,M("other",OTHERPAIR[0],"d",OTHERPAIR[1],1,"hard",False))
exactCompact=compact(exactHistory);assert {e.lineage[1:]for e in exactCompact if e.lineage}>={(sourceCache.generation,sourceCache.origin),OTHERPAIR}
# RLC identity includes the receiver anchor. The same exact source pair can be
# certified against two retained value heads without either relation compacting
# the other away, even after newer ordinary validations win polling/VV maxima.
RLCG=gen(1,A,(KD,ND,BD),1,"base",(2,A));RLCV=ev(2,A,(KD,ND,BD),2,"validate",RLCG.id)
OX=ev(10,A,(KD,ND,BD),10,"edit",RLCG.id,value="X");OY=ev(10,B,(KD,ND,BD),11,"edit",RLCG.id,value="Y");PAIR=((40,C),(41,C))
CX=ev(20,R,(KD,ND,BD),20,"validate",RLCG.id,target=OX.id,lineage=((),*PAIR));CY=ev(20,S,(KD,ND,BD),20,"validate",RLCG.id,target=OY.id,lineage=((),*PAIR))
RX=ev(30,R,(KD,ND,BD),30,"validate",RLCG.id,target=OX.id);SY=ev(30,S,(KD,ND,BD),30,"validate",RLCG.id,target=OY.id)
rlcHistory=frozenset((RLCG,RLCV,OX,OY,CX,CY,RX,SY));rlcCompact=compact(rlcHistory);sourcePair=M("pair",PAIR[0],"source",PAIR[1],40,"hard",False)
mx=M("mx",RLCG.id,"X",OX.id,10,"hard",False);my=M("my",RLCG.id,"Y",OY.id,11,"hard",False)
assert valid(rlcHistory)and all(reset_lineage_covers(rlcHistory,m,sourcePair)and reset_lineage_covers(rlcCompact,m,sourcePair)for m in(mx,my))
assert CX in rlcCompact and CY in rlcCompact
for m in (mx,my):
 assert choose_value(rlcHistory,KD,[m,sourcePair],(KI,KE),{KI:"i",KE:"e"})[1]is m
 assert choose_value(rlcCompact,KD,[m,sourcePair],(KI,KE),{KI:"i",KE:"e"})[1]is m
# Correspondence boundary validation rejects malformed shapes before compaction.
good_cert=next(e for e in lineageResetEvents if e.lineage)
for bad_corr in ((((S,20),),LG.id),(((S,True),),LG.id,LG.id),((('bad',20),),LG.id,LG.id),(((S,20),(S,21)),LG.id,LG.id),(((S,20),(B,10)),LG.id,LG.id),(((S,20),),(True,S),LG.id),(((S,20),),LG.id,(0,S)),(((S,20),),None,LG.id),(((S,20),),LG.id,LG.id,"extra")):
 malformed=(set(lineageR1.journal)-{good_cert})|{replace(good_cert,lineage=bad_corr)}
 assert not valid(malformed)
# Event kind fixes lineage nullability: delete is absent-only; freshness
# assertions are present-only.
assert not valid((set(absentReset.journal)-{absentDelete})|{replace(absentDelete,lineage=(absentDelete.lineage[0],LG.id,LG.id))})
assert not valid((set(lineageR1.journal)-{good_cert})|{replace(good_cert,lineage=(good_cert.lineage[0],None,None))})
# ResetObservation is absence-only and cannot suppress deletes from a present
# generation anchor.
BADOBS=observe(300,C,(K,N,BS),300,LG.id,(((S,50),),None,None));assert not valid((LG,LGV,BADOBS))
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

# Structural deletion closure: KI -> KE -> K. Source deletes only KI; the
# receiver authors direct-dependent and transitive-dependent deletes at tau.
CHAIN={KI:(),KE:(KI,),K:(KE,),KD:()}
CIG=gen(1,A,(KI,NI,BI),1,"a",(2,A));CIV=ev(2,A,(KI,NI,BI),2,"validate",CIG.id)
CDG=gen(3,A,(KE,NE,BE),3,"d",(4,A));CDV=ev(4,A,(KE,NE,BE),4,"validate",CDG.id)
CEG=gen(5,A,(K,N,BS),5,"e",(6,A));CEV=ev(6,A,(K,N,BS),6,"validate",CEG.id)
chainJournal=frozenset((CIG,CIV,CDG,CDV,CEG,CEV))
chainNodes=((KI,M("ca",CIG.id,"a",CIG.id,1,"fresh",True)),(KE,M("cd",CDG.id,"d",CDG.id,3,"fresh",True,((KI,"a"),))),(K,M("ce",CEG.id,"e",CEG.id,5,"fresh",True,((KE,"d"),))))
chainR=Rep(R,0,((A,6),),chainJournal,tuple(sorted(chainNodes)))
# A stale-soft direct input and a transitive hard root propagate staleness upward.
CIH=ev(20,S,(KI,NI,BI),20,"invalidate",CIG.id,"hard");CDS=ev(21,S,(KE,NE,BE),21,"invalidate",CDG.id,"soft",target=CDG.id)
chainStale=Rep(S,21,((A,6),(S,21)),frozenset((CIG,CIV,CDG,CDV,CIH,CDS)),((KI,M("csi",CIG.id,"a",CIG.id,1,"hard",False)),(KE,M("csd",CDG.id,"d",CDG.id,3,"soft",True,((KI,"a"),)))))
chainUp,chainUpEvents=receive(chainR,chainStale,100,CHAIN);assert node(chainUp,KI).state=="hard"and node(chainUp,KE).state=="soft"and node(chainUp,K).state=="soft"and node(chainUp,K).proof
assert len(chainUpEvents)==1 and chainUpEvents[0].key==K and chainUpEvents[0].mode=="soft"
chainBack,chainBackEvents=receive(chainStale,chainUp,schema=CHAIN);assert not chainBackEvents and chainUpEvents[0]in chainBack.journal
rootDelete=dele(10,S,(KI,NI,BI),50);chainS=Rep(S,10,((A,2),(S,10)),frozenset((CIG,CIV,rootDelete)),())
assert validate_replica(chainR,CHAIN)and validate_replica(chainS,CHAIN)
closed,closureEvents=receive(chainR,chainS,100,CHAIN)
assert not closed.nodes and {e.key for e in closureEvents}=={KE,K}and all(e.kind=="delete"and e.time==100 and e.sequence>10 for e in closureEvents)
assert rootDelete in closed.journal and rootDelete.time==50
reverseClosed,reverseDeletes=receive(chainS,closed,schema=CHAIN)
assert not reverseDeletes and reverseClosed.journal==closed.journal and rootDelete.time==50 and all(e in reverseClosed.journal and e.time==100 for e in closureEvents)

# Lazy-clock reverse catch-up includes SemanticGraph equality.
GA=gen(99,A,(KI,NI,BI),1,"a",(100,A));GAV=ev(100,A,(KI,NI,BI),2,"validate",GA.id)
HA=Rep(A,100,((A,100),),frozenset((GA,GAV)),((KI,M("aid",GA.id,"a",GA.id,1,"fresh",True)),))
DB=dele(1,B,(KD,ND,BD),1);HB=Rep(B,1,((B,1),),frozenset((DB,)),())
A1,aa=receive(HA,HB);B1,ba=receive(HB,A1);assert not aa and not ba
assert A1.journal==B1.journal and A1.coverage==B1.coverage and sem(A1)==sem(B1)and B1.clock==1
q=alloc(B1)[0];assert q==101

# Canonical cursor/token scalar domains.
def encode(ch,cur,filter_id="*"):
 raw=json.dumps({"change":ch,"cursor":[list(x)for x in sorted(cur)],"filter":filter_id,"v":1},sort_keys=True,separators=(",",":"));return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
def decode(tok):
 raw=base64.urlsafe_b64decode(tok+"="*((-len(tok))%4)).decode();o=json.loads(raw)
 if set(o)!={"change","cursor","filter","v"}or o["v"]!=1 or type(o["filter"])is not str or not o["filter"]:raise ValueError
 ch=o["change"]
 if type(ch)is not dict or set(ch)!={"nodeName","bindings","action","time"}or type(ch["nodeName"])is not str or type(ch["bindings"])is not list or ch["action"]not in ACT or not timestamp(ch["time"]):raise ValueError
 prodkey(ch["nodeName"],tuple(ch["bindings"]));cs=o["cursor"]
 if cs!=sorted(cs)or len({x for x,_ in cs})!=len(cs)or any(not regex.fullmatch("[a-z]{16}",x)or not uint(n)for x,n in cs):raise ValueError
 if encode(ch,[tuple(x)for x in cs],o["filter"])!=tok:raise ValueError
 return o
ch={"nodeName":N,"bindings":list(BS),"action":"edit","time":40};tok=encode(ch,((A,10),(B,3)));assert decode(tok)
def bad(o):
 t=base64.urlsafe_b64encode(json.dumps(o,sort_keys=True,separators=(",",":")).encode()).decode().rstrip("=")
 try:decode(t)
 except (ValueError,TypeError,KeyError):return
 raise AssertionError("malformed token accepted")
base={"change":ch,"cursor":[[A,1]],"filter":"*","v":1}
for o in({**base,"cursor":[[A,True]]},{**base,"cursor":[[A,2**64]]},{**base,"cursor":[["bad",1]]},{**base,"cursor":[[A,1],[A,2]]},{**base,"cursor":[[B,1],[A,2]]},{**base,"v":2},{**base,"x":1},{**base,"change":{**ch,"time":True}},{**base,"change":{**ch,"time":TMAX+1}},{**base,"change":{**ch,"nodeName":7}},{**base,"change":{**ch,"bindings":{}}}):bad(o)
noncanon=base64.urlsafe_b64encode(json.dumps(base).encode()).decode().rstrip("=")
try:decode(noncanon);raise AssertionError("noncanonical token accepted")
except ValueError:pass

# Filter-bound cursors cannot be broadened or changed silently. Empty results do
# not manufacture continuation, and compaction has identical filtered behavior.
FK1=gen(1,B,(KI,NI,BI),1,"k1",(2,B));FK1V=ev(2,B,(KI,NI,BI),2,"validate",FK1.id);FK2=gen(3,B,(KD,ND,BD),3,"k2",(4,B));FK2V=ev(4,B,(KD,ND,BD),4,"validate",FK2.id)
FA5=ev(5,A,(KI,NI,BI),5,"edit",FK1.id,value="k1-edit");FA10=ev(10,A,(KD,ND,BD),10,"edit",FK2.id,value="k2-edit");FILTERJ=frozenset((FK1,FK1V,FK2,FK2V,FA5,FA10))
k1f=("ground",NI,BI);k2f=("ground",ND,BD);bothf=("union",k1f,k2f);swapped=("union",k2f,k1f);wild=("wildcard",);nonef=("ground","missing",())
k2id=filter_identity(k2f);bothid=filter_identity(bothf);noneid=filter_identity(nonef)
assert k2id!=bothid and bothid==filter_identity(swapped)and k2id==filter_identity(("ground",ND,tuple(BD)))
# ConstValue identity is the quotient induced by production isEqual: JavaScript
# Number spelling and zero sign normalize, while record order remains semantic.
assert filter_identity(("ground","X",(-0.0,)))==filter_identity(("ground","X",(0.0,)))
assert filter_identity(("ground","X",(1,)))==filter_identity(("ground","X",(1.0,)))
nested1=[{"a":1,"b":[-0.0,{"x":True}]}];nested2=[{"a":1.0,"b":[0,{"x":True}]}]
assert filter_identity(("ground","X",(nested1,)))==filter_identity(("ground","X",(nested2,)))
assert filter_identity(("ground","X",({"a":1,"b":2},)))!=filter_identity(("ground","X",({"b":2,"a":1},)))
for invalid in (None,float("nan"),float("inf")):
 try:filter_identity(("ground","X",(invalid,)));assert False
 except ValueError:pass
assert filter_identity(("ground","X",(("wildcard",),)))!=filter_identity(("ground","X",("wildcard",)))
# Wildcard and a finite union happen to match the same current snapshot, but
# their structural identities differ because wildcard also matches future keys.
assert {e.key for e in nmax(FILTERJ)if filter_matches(wild,e)}=={e.key for e in nmax(FILTERJ)if filter_matches(bothf,e)}and filter_identity(wild)!=bothid
k2page=filtered_query(FILTERJ,(),k2f);assert k2page and dict(k2page[-1][1])[A]==10
assert not filtered_query(FILTERJ,k2page[-1][1],k2f,k2id)
try:filtered_query(FILTERJ,k2page[-1][1],bothf,k2id);assert False
except ValueError:pass
assert not filtered_query(FILTERJ,(),nonef)
assert filtered_query(FILTERJ,(),k2f)==filtered_query(compact(FILTERJ),(),k2f)
filterToken=encode(ch,k2page[-1][1],k2id);assert decode(filterToken)["filter"]==k2id

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
 P=sum(ph(cs,k)is not None for k in keys);VH=sum(len(vheads(cs,k,generation(cs,k)))for k in keys if generation(cs,k));IF=sum(len(set().union(*(front(cs,k,generation(cs,k),False,h.id)for h in vheads(cs,k,generation(cs,k)))))for k in keys if generation(cs,k));HF=sum(len(set().union(*(front(cs,k,generation(cs,k),True,h.id)for h in vheads(cs,k,generation(cs,k)))))for k in keys if generation(cs,k));VV=len([e for e in cs if e.kind=="validate"]);RC=len([e for e in cs if e.lineage]);coords=sum(len(e.clears)for e in cs if e.kind=="validate")+sum(len(e.lineage[0])for e in cs if e.lineage)
 return cs,n,r,len(nmax(cs)),P,VH,IF,HF,VV,RC,coords
for n in range(1,5):
 for r in range(1,6):
  es,cov=bounded_history(n,r);cs,nn,rr,Nc,P,VH,IF,HF,VV,RC,coords=category_counts(es);assert(nn,rr)==(n,r)
  assert journal_projection(es)==journal_projection(cs)
  assert Nc<=5*n*r and P<=n and VH<=n*r and IF<=n*r*r and HF<=n*r*r and VV<=2*n*r and RC<=n*r*r and coords<=2*n*r*r
  assert len(cs)+coords+len(cov)<=12*n*r+2*n*r*r+r
for r in range(1,6):
 cov=tuple((x,10)for x in(A,B,C,R,S)[:r]);assert compact(())==frozenset()and len(cov)==r

# Exact semantic reset certificates are lossless; each carrier physically owns
# an O(r) causal vector, so the storage family accounts for c*r coordinates.
CHG=gen(1,A,(K,N,BS),1,"X",(2,A));CHV=ev(2,A,(K,N,BS),2,"validate",CHG.id)
for rr in range(1,6):
 prefix=tuple((a,99)for a in (A,B,C,R,S)[:rr])
 for c0 in range(1,21):
  certs={ev(100+i,R,(K,N,BS),100+i,"validate",CHG.id,target=CHG.id,lineage=(prefix,(10+i,S),(20+i,S)))for i in range(c0)}
  churn=frozenset({CHG,CHV}|certs);cc=compact(churn);c=len({(e.target,*e.lineage[1:])for e in cc if e.lineage and e.lineage[1:]!=(None,None)});coords=sum(len(e.lineage[0])for e in cc if e.lineage)
  assert valid(churn)and c==c0 and coords==c*rr
  assert len(cc)+coords<=5+c*(rr+1)

print("journal semantic verifier passed: convergence, causal validation, observed reset absorption/idempotence, extensional proof transport, polling, compaction, lazy clock, timestamps, and storage")
