const {verifyTargetReplica}=require('../src/generators/incremental_graph/migration_verification');
const {getRootDatabase,parseGraphScheme,GRAPH_SCHEME_KEY,LAST_NODE_INDEX_KEY}=require('../src/generators/incremental_graph/database');
const {createIncrementalGraph}=require('../src/generators/incremental_graph');
const {makeJournalAuthor}=require('../src/generators/incremental_graph/journal');
const {getMockedRootCapabilities}=require('./spies');
const {stubEnvironment,stubLogger,stubDatetime}=require('./stubs');
const {numberComputedValue}=require('./computed_value_fixture');

test('migration target verifier refuses a forged last_node_index',async()=>{
 const c=getMockedRootCapabilities();stubEnvironment(c);stubLogger(c);stubDatetime(c);
 const db=await getRootDatabase(c);
 try {
  const graph=await createIncrementalGraph(c,db,[{output:'A',inputs:[],computor:async()=>numberComputedValue(1),isDeterministic:true,hasSideEffects:false}]);
  await graph.pull('A');
  const storage=db.getSchemaStorage();
  const map=await db.loadIdentifierLookupForReplica(db.currentReplicaName());
  const scheme=parseGraphScheme(await storage.global.get(GRAPH_SCHEME_KEY));
  const localWriter=makeJournalAuthor(db.getFingerprint());
  if(localWriter instanceof Error) throw localWriter;
  const original=await storage.global.get(LAST_NODE_INDEX_KEY);
  await expect(verifyTargetReplica(storage,map,scheme,localWriter,'fixture')).resolves.toBeUndefined();
  await storage.global.put(LAST_NODE_INDEX_KEY,original+1);
  await expect(verifyTargetReplica(storage,map,scheme,localWriter,'fixture')).rejects.toThrow(/last_node_index|watermark/i);
 } finally {await db.close()}
});