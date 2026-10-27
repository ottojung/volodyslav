const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {snapshotFromRenderedReplica} = require('../src/generators/incremental_graph/journal_git_recovery');
const {getMockedRootCapabilities} = require('./spies');
const {stubEnvironment,stubLogger}=require('./stubs');

test('Git recovery refuses a checkpoint whose writerHead exceeds its retained Journal',async()=>{
 const capabilities = getMockedRootCapabilities();
 stubEnvironment(capabilities);stubLogger(capabilities);
 const dest=await fs.mkdtemp(path.join(os.tmpdir(),'j3-corrupt-checkpoint-'));
 const fixture=path.join(__dirname,'mock-incremental-database-remote-populated','rendered','r');
 try{
  await fs.cp(fixture,dest,{recursive:true});
  const p=path.join(dest,'journal','state');
  const state=JSON.parse(await fs.readFile(p,'utf8'));
  state.writerHead=String(Number(state.writerHead)+1);
  state.committedFrontier=[[state.localWriter,state.writerHead]];
  await fs.writeFile(p,JSON.stringify(state));
  await expect(snapshotFromRenderedReplica(capabilities,dest)).rejects.toThrow(/committed frontier/);
 }finally{await fs.rm(dest,{recursive:true,force:true})}
});

test('Git recovery refuses a checkpoint with authority high-water below retained records',async()=>{
 const capabilities=getMockedRootCapabilities();
 stubEnvironment(capabilities);stubLogger(capabilities);
 const dest=await fs.mkdtemp(path.join(os.tmpdir(),'j3-corrupt-highwater-'));
 const fixture=path.join(__dirname,'mock-incremental-database-remote-populated','rendered','r');
 try{
  await fs.cp(fixture,dest,{recursive:true});
  const p=path.join(dest,'journal','state');
  const state=JSON.parse(await fs.readFile(p,'utf8'));
  state.authorityHighWater=[0,'0'];
  await fs.writeFile(p,JSON.stringify(state));
  await expect(snapshotFromRenderedReplica(capabilities,dest)).rejects.toThrow(/high-water/);
 }finally{await fs.rm(dest,{recursive:true,force:true})}
});

test('Git recovery refuses a writer head unsupported by the committed Journal',async()=>{
 const capabilities=getMockedRootCapabilities();
 stubEnvironment(capabilities);stubLogger(capabilities);
 const dest=await fs.mkdtemp(path.join(os.tmpdir(),'j3-corrupt-writerhead-'));
 const fixture=path.join(__dirname,'mock-incremental-database-remote-populated','rendered','r');
 try{
  await fs.cp(fixture,dest,{recursive:true});
  const p=path.join(dest,'journal','state');
  const state=JSON.parse(await fs.readFile(p,'utf8'));
  state.writerHead=String(Number(state.writerHead)+1);
  await fs.writeFile(p,JSON.stringify(state));
  await expect(snapshotFromRenderedReplica(capabilities,dest)).rejects.toThrow(/local writer head/);
 }finally{await fs.rm(dest,{recursive:true,force:true})}
});

test('Git recovery refuses a checkpoint with a forged allocator watermark',async()=>{
 const capabilities=getMockedRootCapabilities();
 stubEnvironment(capabilities);stubLogger(capabilities);
 const dest=await fs.mkdtemp(path.join(os.tmpdir(),'j3-corrupt-allocator-'));
 const fixture=path.join(__dirname,'mock-incremental-database-remote-populated','rendered','r');
 try{
  await fs.cp(fixture,dest,{recursive:true});
  const p=path.join(dest,'journal','state');
  const state=JSON.parse(await fs.readFile(p,'utf8'));
  state.allocatorWatermark=0;
  await fs.writeFile(p,JSON.stringify(state));
  await expect(snapshotFromRenderedReplica(capabilities,dest)).rejects.toThrow(/allocator/);
 }finally{await fs.rm(dest,{recursive:true,force:true})}
});

test('Git recovery refuses a checkpoint whose retained writer stream has a sequence hole',async()=>{
 const capabilities=getMockedRootCapabilities();
 stubEnvironment(capabilities);stubLogger(capabilities);
 const dest=await fs.mkdtemp(path.join(os.tmpdir(),'j3-corrupt-stream-hole-'));
 const fixture=path.join(__dirname,'mock-incremental-database-remote-populated','rendered','r');
 try{
  await fs.cp(fixture,dest,{recursive:true});
  const recordsPath=path.join(dest,'journal');
  const files=(await fs.readdir(recordsPath)).filter(name=>/^record\|[a-z]{9,}\|[0-9]{30}$/.test(name));
  const byWriter=new Map();
  for(const name of files){
   const [,writer,sequence]=/^record\|([a-z]{9,})\|([0-9]{30})$/.exec(name);
   const stream=byWriter.get(writer)||[];
   stream.push({name,sequence});byWriter.set(writer,stream);
  }
  const stream=[...byWriter.values()].find(records=>records.length>1);
  expect(stream).toBeDefined();
  const removed=stream[1];
  await fs.rm(path.join(recordsPath,removed.name));
  await expect(snapshotFromRenderedReplica(capabilities,dest)).rejects.toThrow(/claims a committed prefix|absent/);
 }finally{await fs.rm(dest,{recursive:true,force:true})}
});

test('Git recovery refuses an inconsistent global last_node_index',async()=>{
 const capabilities=getMockedRootCapabilities();
 stubEnvironment(capabilities);stubLogger(capabilities);
 const dest=await fs.mkdtemp(path.join(os.tmpdir(),'j3-corrupt-global-index-'));
 const fixture=path.join(__dirname,'mock-incremental-database-remote-populated','rendered','r');
 try{
  await fs.cp(fixture,dest,{recursive:true});
  await fs.writeFile(path.join(dest,'global','last_node_index'),'0');
  await expect(snapshotFromRenderedReplica(capabilities,dest)).rejects.toThrow(/allocator/);
 }finally{await fs.rm(dest,{recursive:true,force:true})}
});
