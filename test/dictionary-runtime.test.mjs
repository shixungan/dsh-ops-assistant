import test from "node:test";
import assert from "node:assert/strict";
import { defaultDictionaryRecipe } from "../src/dictionary-defs.mjs";
import { dictionaryFingerprint, compileDictionaryQuery, assertDictionaryArguments, validateDictionaryRows, resolveDictionary } from "../src/dictionary-query.mjs";
import { createEvidenceCollector, assetQuery } from "../src/query-evidence.mjs";
import { createQueryRuntime } from "../src/query-runtime.mjs";
import { createDshAnalyzer } from "../src/dsh.mjs";

const schema = (name,properties,required=[]) => ({name,description:"fixture",parameters:{type:"object",properties,required}});
const assetTool=schema("asset-execute_sql",{sql:{type:"string"}},["sql"]);
const eventTool=schema("event-execute_sql",{sql:{type:"string"}},["sql"]);
const pathTool=schema("graph-read-cypher",{query:{type:"string"},params:{type:"object"}},["query","params"]);
const searchTool=schema("docs-search",{keyword:{type:"string"},limit:{type:"integer"},collection:{type:"string"}},["keyword","collection"]);
const schemas=[assetTool,eventTool,pathTool,searchTool];
const entry=(purpose,tool,extra={}) => ({id:purpose,name:purpose,revision:1,purpose,tool:tool.name,recipe:defaultDictionaryRecipe(purpose),
  timeSemantics:"当前采集快照",validation:{status:"verified",revision:1,toolFingerprint:dictionaryFingerprint(tool)},...extra});
const asset=entry("assets",assetTool), events=entry("events",eventTool), paths=entry("paths",pathTool);
const fixtureTask={id:"task",workspace:"/ops",queryPlan:{dictionaryBindings:{assets:asset.id,events:events.id,paths:paths.id}},queryDictionary:[asset,events,paths]};
const run={id:"run",start:1794474000000,end:1794475800000,alerts:[{alertId:"s:1",title:"ping ERR_LINK_FAILURE",host:"probe",raw:{tags:["srcip=192.0.2.10","dstip=198.51.100.20"]}}]};
const assetRows=[{ip_address:"192.0.2.10",switch_hostname:"EDGE-A"},{ip_address:"198.51.100.20",switch_hostname:"EDGE-B"}];
const pathRows=[{src:"EDGE-A",dst:"EDGE-B",switches:[{hostname:"EDGE-A"},{hostname:"CORE"},{hostname:"EDGE-B"}],links:[]}];
const eventRows=[{kind:"interface",id:"1",host:"CORE",event_time:"2026-11-12T12:00:00Z",event:"down"}];
const signal=()=>new AbortController().signal;
const collectWith=(calls,response) => createEvidenceCollector({invoke:async(name,args)=>{calls.push({name,args});return response?response(name,args):name===assetTool.name?assetRows:name===pathTool.name?pathRows:eventRows;}});

test("dictionary templates project aliases, preserve IP inference, quote identifiers and reject query expressions",()=>{
  const a={...asset,recipe:{table:"ops.devices",columns:{ip_address:"host_ip",switch_hostname:"edge_name",asset_name:"device_name"}}};
  const query=compileDictionaryQuery(a,{ips:["192.0.2.10"]},{validation:true});
  assert.match(query.sql,/host\("host_ip"::inet\) AS "ip_address"/); assert.match(query.sql,/"ops"\."devices"/);
  assert.match(query.sql,/LIMIT 5$/); assert.doesNotMatch(query.sql.split(" WHERE ")[1],/::inet/);
  assert.throws(()=>compileDictionaryQuery({...a,recipe:{...a.recipe,table:"devices; DROP TABLE users"}},{ips:["192.0.2.1"]}),/标识符/);
  assert.throws(()=>compileDictionaryQuery(a,{ips:["192.0.2.1' OR true"]}),/无效/);
});
test("built-in and mapped IP outputs remove inet masks while preserving indexed predicates",()=>{
  const builtin=assetQuery(["192.0.2.10","2001:db8::1"]).sql;
  assert.match(builtin,/SELECT host\(ip_address::inet\) AS ip_address/);
  assert.match(builtin,/WHERE ip_address IN/);assert.doesNotMatch(builtin,/WHERE host\(/);
  const mapped=compileDictionaryQuery({...asset,recipe:{table:"ops.devices",columns:{ip_address:"address",switch_hostname:"edge",switch_mgmt_ip:"management"}}},{ips:["2001:db8::1"]}).sql;
  assert.match(mapped,/host\("address"::inet\) AS "ip_address"/);
  assert.match(mapped,/"management"::text AS "switch_mgmt_ip"/);
  assert.match(mapped,/WHERE "address" IN \(E'2001:db8::1'\)/);
});
test("event templates retain raw indexed time predicates for seconds/milliseconds and normalize returned time",()=>{
  for(const timeType of ["timestamp","unix-seconds","unix-millis"]){
    const e={...events,recipe:{sources:[{...events.recipe.sources[0],timeType,detailColumn:"",interfaceColumn:""}]}};
    const sql=compileDictionaryQuery(e,{hosts:["EDGE'1"],start:run.start,end:run.end},{validation:true}).sql;
    assert.match(sql,/EDGE''1/); assert.match(sql,/NULL::text AS interface/); assert.match(sql,/LIMIT 5$/);
    if(timeType!=="timestamp")assert.ok(sql.includes(`"observed_at" >= ${run.start/(timeType==="unix-seconds"?1000:1)}`));
    if(timeType==="unix-millis")assert.match(sql,/to_timestamp\("observed_at"::double precision \/ 1000\.0\)/);
  }
  assert.throws(()=>compileDictionaryQuery(events,{hosts:["EDGE"],start:0,end:3600001},{validation:true}),/一小时/);
});
test("path recipes keep endpoints in params and bound traversals without guessing property expressions",()=>{
  const p={...paths,recipe:{nodeLabel:"Device",relationType:"LINK",hostnameProperty:"device_name",activeProperty:""}};
  const args=compileDictionaryQuery(p,{pairs:[{src:"X' MATCH(x)",dst:"Y"}]},{validation:true});
  assert.doesNotMatch(args.query,/X' MATCH/);assert.equal(args.params.pairs[0].src,"X' MATCH(x)");
  assert.match(args.query,/:`LINK`\*0\.\.8/);assert.doesNotMatch(args.query,/r\.`active`/);assert.match(args.query,/LIMIT 5$/);
});
test("search recipes use configured scope, forbid arbitrary SQL and validate required argument types",()=>{
  const k=entry("knowledge",searchTool,{recipe:{queryKey:"keyword",limitKey:"limit",fixedArgs:{collection:"manuals"}}});
  const args=compileDictionaryQuery(k,{query:"ERR_LINK"});assert.deepEqual(args,{collection:"manuals",keyword:"ERR_LINK",limit:3});
  assert.doesNotThrow(()=>assertDictionaryArguments(k,searchTool,args));
  assert.throws(()=>assertDictionaryArguments(k,searchTool,{keyword:"ERR"}),/必填/);
  assert.throws(()=>assertDictionaryArguments(k,searchTool,{...args,limit:"3"}),/类型/);
  assert.throws(()=>compileDictionaryQuery({...k,recipe:{...k.recipe,sql:"SELECT 1"}},{query:"ERR"}),/无效/);
});
test("dictionary validation distinguishes missing fields and invalid timestamps from an empty result",()=>{
  validateDictionaryRows("events",[]);validateDictionaryRows("assets",assetRows);
  assert.throws(()=>validateDictionaryRows("assets",[{ip_address:"192.0.2.1"}]),/字段/);
  assert.throws(()=>validateDictionaryRows("events",[{kind:"interface",id:"1",host:"EDGE",event_time:"not a time"}]),/字段/);
  assert.throws(()=>validateDictionaryRows("paths",[{src:"A",dst:"B",switches:[{}],links:[]}]),/字段/);
});
test("purpose-specific dictionary tools execute and scoped evidence records snapshot semantics",async()=>{
  const calls=[],collect=collectWith(calls);const evidence=await collect({run,task:fixtureTask,schemas,signal:signal()});
  assert.deepEqual(calls.map(c=>c.name),[assetTool.name,pathTool.name,eventTool.name]);
  assert.ok(calls[2].args.sql.includes("CORE"));assert.deepEqual(evidence.dictionary.map(d=>d.id),["assets","events","paths"]);
  assert.equal(evidence.dictionary[0].timeSemantics,"当前采集快照");assert.equal(evidence.dictionary[0].revision,1);
});
test("explicit unavailable, changed or unverified dictionaries never fall back to legacy queries",async()=>{
  for(const modified of [null,{...asset,validation:{status:"unverified"}}, {...asset,revision:2}, {...asset,tool:"missing"}]){
    const calls=[],collect=collectWith(calls),task={...fixtureTask,queryDictionary:modified?[modified,events,paths]:[events,paths]};
    const evidence=await collect({run,task,schemas,signal:signal()});
    assert.equal(calls.length,0);assert.equal(evidence.queries[0].status,"unavailable");
  }
  const calls=[],changed=schemas.map(s=>s===assetTool?{...s,description:"new schema"}:s);
  const evidence=await collectWith(calls)({run,task:fixtureTask,schemas:changed,signal:signal()});
  assert.equal(calls.length,0);assert.equal(evidence.dictionary[0].status,"schema_changed");
});
test("empty successful validation is usable with an explicit unsampled-field note",()=>{
  const task={...fixtureTask,queryDictionary:[{...asset,validation:{...asset.validation,status:"empty"}},events,paths]};
  const dict=resolveDictionary(task,schemas);assert.equal(dict.entries.assets.status,"ready");assert.match(dict.entries.assets.note,/字段.*尚未采样/);
});
test("dictionary revision invalidates cross-run cache and bounded documentation only includes selected entries",async()=>{
  const calls=[],collect=collectWith(calls);
  const task=structuredClone(fixtureTask);task.queryDictionary.push(entry("reference",assetTool,{id:"unselected",document:"NOT_IN_CONTEXT"}));
  task.queryDictionary[0].document="字".repeat(16000);
  const first=await collect({run,task,schemas,signal:signal()});
  const repeated=await collect({run:{...run,id:"next"},task,schemas,signal:signal()});
  assert.equal(repeated.queries[0].cacheHit,true);assert.equal(JSON.stringify(first).includes("NOT_IN_CONTEXT"),false);
  assert.equal(first.dictionary[0].documentationTruncated,true);assert.ok(first.dictionary.reduce((n,e)=>n+(e.document?.length??0),0)<=10000);
  task.queryDictionary[0].revision=2;task.queryDictionary[0].validation.revision=2;
  const revised=await collect({run:{...run,id:"revision"},task,schemas,signal:signal()});assert.equal(revised.queries[0].cacheHit,false);
});

function mockHost(options={}){
  const agents=new Map(),calls=[],prompts=[],titles=[];
  const ctx={tools:{schemas:()=>schemas,get:name=>schemas.find(s=>s.name===name)},agents:{get:id=>agents.get(id)},sessionController:{
    async create(){const id=`session-${agents.size+1}`,registered=new Map(),agent={ctx:{},inject(){}};
      agent.ctx.tools={restrict:value=>{agent.restriction=value;},guard:fn=>{agent.guard=fn;},register:d=>registered.set(d.name,d),setExecutor:e=>{agent.executor=e;}};
      agent.registered=registered;agents.set(id,agent);return {sessionId:id};},async rename({title}){titles.push(title);},async prompt(value){prompts.push(value);}
  }};
  class Pipeline{constructor(context){this.context=context;}}
  const sdk={ToolExecutionPipeline:Pipeline,projectToolSchema:x=>x,async executeToolBatch(input){
    const results=[];
    for(const c of input.calls){const args=JSON.parse(c.arguments),exec={name:c.name,callId:c.id,arguments:args,agent:input.agent,token:Symbol(),signal:input.signal};
      assert.equal(input.agent.guard(exec),undefined);calls.push({name:c.name,args,exec});
      const raw=options.response?await options.response(c.name,args,input.signal):assetRows;
      const visible=options.redact?options.redact(raw):raw;
      results.push({callId:c.id,result:{isError:options.isError??false,error:options.isError?{message:"denied"}:undefined,content:[{type:"text",text:JSON.stringify(visible)}],value:raw}});
    }
    return {results,...options.batchExtra};
  }};
  return {ctx,agents,calls,prompts,titles,sdk,analyze:createDshAnalyzer(ctx,{loadSdk:async()=>sdk})};
}
test("manual verification uses one named policy session without a model prompt and seals it on completion",async()=>{
  const h=mockHost(),result=await h.analyze.validateDictionary(asset,{workspace:"/ops",sample:{ips:["192.0.2.10"]}},signal());
  assert.equal(result.status,"verified");assert.equal(result.toolFingerprint,dictionaryFingerprint(assetTool));assert.equal(result.rowCount,2);
  assert.ok(result.fields.includes("ip_address"));assert.equal(h.prompts.length,0);assert.deepEqual(h.titles,["MCP字典验证 · assets"]);
  const agent=h.agents.get(result.sessionId);assert.deepEqual(agent.restriction.allow,[assetTool.name]);
  assert.match(agent.guard(h.calls[0].exec),/结束|格式/);assert.deepEqual(agent.executor.describe([...agent.registered.values()]).schemas,[]);
  assert.equal(JSON.stringify(result).includes("192.0.2.10"),false,"sample values are not persisted");
});
test("verification rejects unsafe samples before opening any session",async()=>{
  const h=mockHost();const result=await h.analyze.validateDictionary(asset,{workspace:"/ops",sample:{ips:["oops'"]}},signal());
  assert.equal(result.status,"failed");assert.equal(h.agents.size,0);assert.equal(h.calls.length,0);
});
test("verification preserves final redaction, empty result status, structure errors and policy termination",async()=>{
  for(const [options,status] of [[{response:()=>[]},"empty"],[{redact:()=>[]},"empty"],[{response:()=>[{wrong:"schema"}]},"failed"],[{isError:true},"failed"],[{batchExtra:{concluded:true}},"failed"]]){
    const h=mockHost(options),r=await h.analyze.validateDictionary(asset,{workspace:"/ops",sample:{ips:["192.0.2.10"]}},signal());
    assert.equal(r.status,status);assert.equal(h.prompts.length,0);assert.match([...h.agents.values()][0].guard(h.calls[0].exec),/结束|格式/);
  }
});
test("cancelled dictionary verification drains the tool and never records success",async()=>{
  const controller=new AbortController();let finished=false;
  const h=mockHost({response:async(_n,_a,s)=>{controller.abort(new Error("stop"));await new Promise(r=>setTimeout(r,10));finished=true;return assetRows;}});
  const r=await h.analyze.validateDictionary(asset,{workspace:"/ops",sample:{ips:["192.0.2.10"]}},controller.signal);
  assert.equal(finished,true);assert.equal(r.status,"failed");assert.match(r.message,/stop/);
});
test("dictionary raw tools remain inaccessible to model calls while generated requests use exact permits",async()=>{
  const h=mockHost({response:name=>name===assetTool.name?assetRows:name===pathTool.name?pathRows:eventRows});
  const {sessionId}=await h.ctx.sessionController.create(),agent=h.agents.get(sessionId);
  const record=await createQueryRuntime(h.ctx,{loadSdk:async()=>h.sdk})(agent,fixtureTask,{toolCallsUsed:0});
  assert.match(agent.guard({name:assetTool.name,agent,token:Symbol(),callId:"guess",arguments:{sql:"SELECT * FROM secrets"}}),/固定/);
  await record.prepare(run,signal());assert.deepEqual(h.calls.map(c=>c.name),[assetTool.name,pathTool.name,eventTool.name]);
  assert.deepEqual(agent.executor.describe([...schemas,...agent.registered.values()]).schemas.map(d=>d.name),["ops_lookup"]);
});
