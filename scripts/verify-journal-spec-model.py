#!/usr/bin/env python3
"""Bounded semantic transition model for the IncrementalGraph journal specification."""
from dataclasses import dataclass, replace
from itertools import product
from pathlib import Path
import base64,json,re as regex
U64=2**64-1;TMIN=-8640000000000000;TMAX=8640000000000000
A="aaaaaaaaaaaaaaaa";B="bbbbbbbbbbbbbbbb";C="cccccccccccccccc";R="rrrrrrrrrrrrrrrr";S="ssssssssssssssss"
AUTH={A,B,C,R,S};ACT={"add","edit","delete","invalidate","validate"};ROOT=Path(__file__).parent
KV=json.loads((ROOT/"fixtures/node-key-serialization.json").read_text());TV=json.loads((ROOT/"fixtures/unix-timestamp-domain.json").read_text())
def addr(i):v=KV[i];return(v["serialized"],v["nodeName"],tuple(v["bindings"]))
K,N,BS=addr(3);KI,NI,BI=addr(0);KD,ND,BD=addr(1)
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
   if any(a not in AUTH or not uint(q) for a,q in e.clears):return False
  else:return False
 for e in es:
  if e.generation:
   g=d.get(e.generation)
   if not g or g.kind!="add" or g.key!=e.key:return False
  if e.kind=="add":
   f=d.get(e.initial)
   if not f or f.kind not in ("validate","invalidate") or f.generation!=e.id or f.id<=e.id:return False
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
def alloc(r,count=1):
 top=max([r.clock]+[e.sequence for e in r.journal]+list(dict(r.coverage).values()));return list(range(top+1,top+count+1))
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

def receive(r,s):
 before=len(r.journal);j=merge(r.journal,s.journal);cov=vmax(r.coverage,s.coverage);nodes={}
 authored=[]
 for k in set(dict(r.nodes))|set(dict(s.nodes))|{e.key for e in j}:
  selected=choose_value(j,k,[node(r,k),node(s,k)])
  if not selected:continue
  g,best=selected
  # Extensional transport requires a real proof and semantic equality of inputs/output.
  proof=any(m and m.proof and m.value==best.value and m.inputs==best.inputs for m in(node(r,k),node(s,k)))
  st=classify(j,k,g)
  if st=="hard":proof=False
  if not proof and st=="fresh":
   # Genuine unrepresented destructive decision: author hard, so receive is not defined silent.
   q=alloc(replace(r,journal=j,coverage=cov),1)[0];h=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),best.modified,"invalidate",g,"hard");authored.append(h);j=merge(j,(h,));cov=vmax(cov,((r.fp,q),));st="hard"
  nodes[k]=M(best.identifier,g,best.value,best.origin,best.modified,st,proof,best.inputs)
 out=Rep(r.fp,max([r.clock]+[e.sequence for e in authored]),cov,j,tuple(sorted(nodes.items())),r.nextid)
 return out,tuple(authored)
def best_key_name(k):
 for v in KV:
  if v["serialized"]==k:return v["nodeName"]
 raise KeyError
def best_key_bindings(k):
 for v in KV:
  if v["serialized"]==k:return tuple(v["bindings"])
 raise KeyError

def validation_covering(es,k,g,coverage):return any(v.kind=="validate"and v.key==k and v.generation==g and all(i.sequence<=dict(v.clears).get(i.author,0)for i in front(es,k,g))for v in es)
def reset(r,s,tau,target_override=None):
 # Source snapshot is validated and tau cannot precede an observed unequal value event.
 for _,m in s.nodes:
  if m.modified>tau:raise ValueError("unsupported clock")
 hypothetical=set(r.journal)|set(s.journal);nodes={};events=[];work=r
 for k,sm in s.nodes:
  rm=node(r,k);target=target_override.get(k,sm.state)if target_override else sm.state
  if rm is None:
   q1,q2=alloc(work,2);g=gen(q1,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,sm.value,(q2,r.fp));fkind="validate"if target=="fresh"else"invalidate";mode=None if target=="fresh"else target.replace("stale-","");f=ev(q2,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,fkind,g.id,mode,tuple(sorted(vmax(r.coverage,s.coverage)))if fkind=="validate"else());events.extend((g,f));work=add_events(work,(g,f));m=M(f"{r.fp}-{r.nextid}",g.id,sm.value,g.id,tau,target,sm.proof if target!="hard"else False,sm.inputs)
  else:
   m=replace(rm,value=sm.value,inputs=sm.inputs,proof=sm.proof if target!="hard"else False,state=target)
   if rm.value!=sm.value:
    q=alloc(work)[0];e=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"edit",rm.generation,value=sm.value);events.append(e);work=add_events(work,(e,));m=replace(m,origin=e.id,modified=tau)
   g=m.generation;combined=set(hypothetical)|set(events);closed=vmax(r.coverage,s.coverage)
   if target=="fresh" and not validation_covering(combined,k,g,closed):
    q=alloc(work)[0];v=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"validate",g,clears=closed);events.append(v);work=add_events(work,(v,))
   elif target=="soft":
    # If an uncovered soft already represents target, idempotence is silent.
    existing_soft=not hard(combined,k,g)and not fresh(combined,k,g)
    if not existing_soft:
     q1,q2=alloc(work,2);v=ev(q1,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"validate",g,clears=closed);i=ev(q2,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"invalidate",g,"soft");events.extend((v,i));work=add_events(work,(v,i))
   elif target=="hard" and not hard(set(work.journal)|set(events),k,g):
    q=alloc(work)[0];i=ev(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau,"invalidate",g,"hard");events.append(i);work=add_events(work,(i,))
  nodes[k]=m
 # Receiver materializations absent from source are deleted and their identifiers retire.
 retired=list(r.retired)
 for k,rm in r.nodes:
  if node(s,k)is None:
   q=alloc(work)[0];d=dele(q,r.fp,(k,best_key_name(k),best_key_bindings(k)),tau);events.append(d);work=add_events(work,(d,));retired.append(rm.identifier)
 return replace(work,nodes=tuple(sorted(nodes.items())),nextid=max(work.nextid,r.nextid+sum(1 for k,_ in s.nodes if node(r,k)is None)),retired=tuple(retired)),tuple(events)

# Common generation and independent fresh histories expose naive fresh+fresh -> hard.
G=gen(1,A,(K,N,BS),1,"d",(2,A));V0=ev(2,A,(K,N,BS),2,"validate",G.id,clears=())
IR=ev(10,R,(K,N,BS),10,"invalidate",G.id,"hard");VR=ev(11,R,(K,N,BS),11,"validate",G.id,clears=((R,10),))
IS=ev(20,S,(K,N,BS),20,"invalidate",G.id,"hard");VS=ev(21,S,(K,N,BS),21,"validate",G.id,clears=((S,20),))
JR=frozenset((G,V0,IR,VR));JS=frozenset((G,V0,IS,VS));assert valid(JR)and valid(JS)
assert fresh(JR,K,G.id)and fresh(JS,K,G.id)
JU=merge(JR,JS);assert hard(JU,K,G.id)and not fresh(JU,K,G.id)
mR=M("r-id",G.id,"d",G.id,1,"fresh",True,((KI,"a"),));mS=M("s-id",G.id,"d",G.id,1,"fresh",True,((KI,"a"),))
RR=Rep(R,11,((A,2),(R,11)),JR,((K,mR),));SS=Rep(S,21,((A,2),(S,21)),JS,((K,mS),))
R1,re=reset(RR,SS,30);assert re and any(e.kind=="validate"and dict(e.clears).get(S)>=21 and dict(e.clears).get(R)>=11 for e in re)
R2,auth=receive(R1,SS);assert sem(R2)==sem(R1)and not auth and node(R2,K).state=="fresh"
# Reset idempotence is fully silent.
R1b,re2=reset(R1,SS,30);assert not re2 and R1b==R1

# Equal input/output values at different provenance revisions transport actual proof.
GI_R=gen(9,R,(KI,NI,BI),5,"a",(10,R));VI_R=ev(10,R,(KI,NI,BI),6,"validate",GI_R.id)
GI_S=gen(99,S,(KI,NI,BI),5,"a",(100,S));VI_S=ev(100,S,(KI,NI,BI),6,"validate",GI_S.id)
DR=replace(mR,inputs=((KI,"a"),));DS=replace(mS,inputs=((KI,"a"),))
XR=Rep(R,10,((R,10),),frozenset((GI_R,VI_R,G,V0)),((KI,M("ar",GI_R.id,"a",GI_R.id,5,"fresh",True)),(K,DR)))
XS=Rep(S,100,((S,100),),frozenset((GI_S,VI_S,G,V0)),((KI,M("as",GI_S.id,"a",GI_S.id,5,"fresh",True)),(K,DS)))
X1,_=reset(XR,XS,30);X2,xa=receive(X1,XS);assert node(X2,K).proof and node(X2,K).state=="fresh"and not xa

# Unequal reset value: same identifier/generation, scoped edit at tau, no generation.
SY=replace(mS,value="Y",modified=7,origin=G.id)
YS=replace(SS,nodes=((K,SY),));Y1,ye=reset(RR,YS,40);ym=node(Y1,K)
assert ym.identifier==mR.identifier and ym.generation==G.id and ym.value=="Y"and ym.modified==40
assert len([e for e in ye if e.kind=="edit"and e.time==40])==1 and not any(e.kind=="add"for e in ye)
Y2,ye2=reset(Y1,YS,40);assert not ye2 and Y2==Y1
EMPTY=Rep(S,1,(),frozenset(),());YD,yde=reset(RR,EMPTY,40);assert node(YD,K)is None and mR.identifier in YD.retired and any(e.kind=="delete"for e in yde)
YREM,yre=reset(YD,YS,50);assert node(YREM,K).identifier!=mR.identifier and any(e.kind=="add"for e in yre)

# Equal value with numerically greater source generation: no reset fence/edit, timestamp preserved.
GS=gen(99,S,(K,N,BS),5,"d",(100,S));GSV=ev(100,S,(K,N,BS),6,"validate",GS.id)
EQ_S=Rep(S,100,((S,100),),frozenset((GS,GSV)),((K,M("sid",GS.id,"d",GS.id,5,"fresh",True,((KI,"a"),))),))
EQ_R=Rep(R,11,((R,11),),JR,((K,mR),))
EQ1,eqe=reset(EQ_R,EQ_S,30);assert not any(e.kind in("add","edit")for e in eqe)and node(EQ1,K).modified==mR.modified
EQ2,eqa=receive(EQ1,EQ_S);assert node(EQ2,K).value=="d"and node(EQ2,K).proof and not eqa
# Third absent host learns only through actual public add; no hidden positive event exists.
ABS=Rep(B,1,((B,1),),frozenset((dele(1,B,(K,N,BS),1),)),())
AB2,_=receive(ABS,EQ_S);assert node(AB2,K)and any(e.kind=="add"for e in EQ_S.journal)

# Fresh source resets stale receiver with joint causal validation and is absorbed.
staleR=replace(RR,nodes=((K,replace(mR,state="hard",proof=False)),))
FR,fe=reset(staleR,SS,30);assert node(FR,K).state=="fresh"and any(e.kind=="validate"for e in fe)
FR2,fa=receive(FR,SS);assert sem(FR2)==sem(FR)and not fa

# Soft target clears independent old hard histories then leaves new soft uncovered.
Soft1,se=reset(RR,SS,30,{K:"soft"});assert [e.kind for e in se][-2:]==["validate","invalidate"]and se[-1].mode=="soft"
Soft2,sa=receive(Soft1,SS);assert node(Soft2,K).state=="soft"and node(Soft2,K).proof and not sa

# Hard source resets fresh receiver: retained local hard assertion, no proof, later no echo.
hardS=replace(SS,nodes=((K,replace(mS,state="hard",proof=False)),))
H1,he=reset(RR,hardS,30,{K:"hard"});assert any(e.kind=="invalidate"and e.mode=="hard"for e in he)and not node(H1,K).proof
H2,ha=receive(H1,hardS);assert node(H2,K).state=="hard"and not ha

# Observed prefix clears delayed A40 but not unseen A51.
G50=gen(1,B,(KD,ND,BD),1,"z",(2,B));GV=ev(2,B,(KD,ND,BD),2,"validate",G50.id)
I40=ev(40,A,(KD,ND,BD),10,"invalidate",G50.id,"hard");Vreset=ev(60,R,(KD,ND,BD),20,"validate",G50.id,clears=((A,50),(B,2)))
assert covers(Vreset,I40)
I51=ev(51,A,(KD,ND,BD),21,"invalidate",G50.id,"hard");assert not covers(Vreset,I51)
assert fresh((G50,GV,Vreset,I40),KD,G50.id)and hard((G50,GV,Vreset,I51),KD,G50.id)
# Future union with delayed covered evidence agrees around compaction.
CA=frozenset((G50,GV,Vreset));CB=frozenset((G50,GV,I40,I51))
assert compact(compact(CA)|CB)==compact(CA|CB)

# Polling maxima preserve reset transitions and causal stabilization through compaction.
cursor=((R,0),);pollsets=[frozenset(JR|JS|set(xs)) for xs in (ye,fe,se,he)];acts={a for ps in pollsets for a,_ in query(ps,cursor)}
assert {"edit","validate","invalidate"}<=acts and all(query(ps,cursor)==query(compact(ps),cursor) for ps in pollsets)
# Ordinary add/delete remain explicit.
GADD=gen(70,R,(KD,ND,BD),40,"n",(71,R));VADD=ev(71,R,(KD,ND,BD),40,"validate",GADD.id);DEL=dele(72,R,(KD,ND,BD),41)
assert {a for a,_ in query((GADD,VADD,DEL))}=={"add","validate","delete"}

# Unsupported future-dated source is rejected under the normative wall-clock premise.
try:reset(RR,replace(SS,nodes=((K,replace(mS,modified=31)),)),30);assert False
except ValueError:pass

# Receive can genuinely author an unrepresented hardening decision; no-echo is not definitional.
NOPROOF=replace(RR,nodes=((K,replace(mR,proof=False)),))
NP,np_events=receive(NOPROOF,NOPROOF);assert len(np_events)==1 and np_events[0].kind=="invalidate" and np_events[0].mode=="hard" and node(NP,K).state=="hard"

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

# Storage category accounting, including n=0,r>0.
def storage_categories(es,coverage):
 es=compact(es);n=len({e.key for e in es});r=len({e.author for e in es}|set(dict(coverage)))
 entries=len(es);vector_coordinates=sum(len(e.clears)for e in es if e.kind=="validate")+len(coverage)
 return n,r,entries,vector_coordinates
for es,cov in((JU,vmax(RR.coverage,SS.coverage)),(CA|CB,((A,51),(B,2),(R,60))), (frozenset(),((A,50),(B,9)))):
 n,r,entries,coords=storage_categories(es,cov);bound=12*(n*r*r+r)
 assert entries+coords<=bound
 if n==0:assert entries==0 and coords==r

print("journal semantic verifier passed: convergence, causal validation, observed reset absorption/idempotence, extensional proof transport, polling, compaction, lazy clock, timestamps, and storage")
