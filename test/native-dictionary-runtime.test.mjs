import test from "node:test";
import assert from "node:assert/strict";
import { nativeArguments, assertNativeSchema, nativeResult } from "../src/native-query.mjs";
import { dictionaryFingerprint, resolveDictionary } from "../src/dictionary-query.mjs";
import { createQueryRuntime } from "../src/query-runtime.mjs";
import { createDshAnalyzer } from "../src/dsh.mjs";

const trace = { name:"fixture_trace_path",description:"synthetic route query", parameters:{type:"object",properties:{src_ip:{type:"string",format:"ipv4"},dst_ip:{type:"string",format:"ipv4"},depth:{type:"integer",minimum:1,maximum:16}},required:["src_ip","dst_ip"],additionalProperties:false} };
const inspect = { name:"fixture_get_metrics",parameters:{type:"object",properties:{ip:{type:"string"},from:{type:"integer"}},required:["ip","from"],additionalProperties:false} };
const pg={name:"postgresql-switch-info-execute_sql",parameters:{type:"object",properties:{sql:{type:"string"}}}};
const neo={name:"neo4j_readonly-read-cypher",parameters:{type:"object",properties:{query:{type:"string"},params:{type:"object"}}}};
const entry=(id,tool,args)=>({id,name:id,revision:1,purpose:"tool",tool:tool.name,description:"only explicit selected evidence",recipe:{arguments:args},validation:{status:"verified",revision:1,toolFingerprint:dictionaryFingerprint(tool),checkedAt:1}});
const route=entry("route",trace,{src_ip:"{{alert.srcip}}",dst_ip:"{{alert.dstip}}",depth:8});
const metric=entry("metric",inspect,{ip:"{{alert.dstip}}",from:"{{window.start}}"});
const alert=(id,dst="198.51.100.20")=>({alertId:id,title:"ping loss",host:"probe",raw:{tags:["srcip=192.0.2.10",`dstip=${dst}`]}});
const run={id:"r",start:1000,end:1801000,alerts:[alert("s:1"),alert("s:2","198.51.100.30"),alert("s:3")]};
const task={id:"t",workspace:"/ops",queryPlan:{dictionaryIds:["route","metric"],maxSupplementaryCalls:3},queryDictionary:[route,metric]};
const signal=()=>new AbortController().signal;

function host(options={}) {
  const schemas=options.schemas??[trace,inspect,pg,neo],agents=new Map(),calls=[],prompts=[],titles=[];
  const create=async()=>{const id=`session-${agents.size+1}`,registered=new Map(),agent={ctx:{},inject(){}};
    agent.ctx.tools={restrict:v=>{agent.restriction=v;},guard:fn=>{agent.guard=fn;},register:d=>registered.set(d.name,d),setExecutor:e=>{agent.executor=e;}};
    agent.registered=registered;agents.set(id,agent);return {sessionId:id};};
  const ctx={tools:{schemas:()=>schemas,get:name=>schemas.find(t=>t.name===name)},agents:{get:id=>agents.get(id)},sessionController:{create,rename:async({title})=>titles.push(title),prompt:async p=>prompts.push(p)}};
  class Pipeline {
    constructor(context){this.context=context;}
    async prepare(input){const exec={...input,token:Symbol()};assert.equal(input.agent.guard(exec),undefined);return {kind:"dispatch",exec};}
    async dispatch(exec){calls.push(exec);const raw=options.response?await options.response(exec):{route:["A","B"],verified:false};const visible=options.redact?options.redact(raw):raw;return {content:[{type:"text",text:JSON.stringify(visible)}],value:raw};}
    async complete(_exec,outcome){return outcome;}
  }
  const sdk={ToolExecutionPipeline:Pipeline,projectToolSchema:x=>x,async executeToolBatch(input,pipeline){const results=[];for(const call of input.calls){const p=await pipeline.prepare({name:call.name,callId:call.id,arguments:JSON.parse(call.arguments),agent:input.agent,signal:input.signal});results.push({callId:call.id,result:await pipeline.complete(p.exec,await pipeline.dispatch(p.exec))});}return {results};}};
  const analyze=createDshAnalyzer(ctx,{loadSdk:async()=>sdk});
  async function fixture(overrides={}) { const {sessionId}=await create(),agent=agents.get(sessionId),context={toolCallsUsed:0};const record=await createQueryRuntime(ctx,{loadSdk:async()=>sdk})(agent,{...task,...overrides},context);
    await record.prepare(run,signal());record.running=true;
    const exec={agent,token:Symbol(),callId:"outer",signal:signal(),toolSet:{},deferContext(){},concludeTurn(){}};
    return {agent,record,context,lookup:(args,extra={})=>agent.registered.get("ops_lookup").execute(args,{...exec,...extra})}; }
  return {ctx,agents,calls,prompts,titles,analyze,fixture};
}

test("native templates use exact alert and window values without evaluating code",()=>{
  assert.deepEqual(nativeArguments(route,{alert:run.alerts[1],run}),{src_ip:"192.0.2.10",dst_ip:"198.51.100.30",depth:8});
  const e=entry("x",inspect,{from:"{{window.startSeconds}}",to:"{{window.endIso}}",label:"x={{alert.labels.site}}"});
  assert.deepEqual(nativeArguments(e,{run,alert:{raw:{labels:{site:"blue"}}}}),{from:1,to:new Date(run.end).toISOString(),label:"x=blue"});
  for(const key of ["alert.raw.password","process.env","alert.labels.__proto__","alert.labels.api_key"]) assert.throws(()=>nativeArguments({...route,recipe:{arguments:{ip:`{{${key}}}`}}},{alert:run.alerts[0],run}),/参数|占位/);
  assert.deepEqual(nativeArguments({...route,recipe:{arguments:{ids:"{{alert.labels.ids}}",limit:"{{alert.labels.limit}}"}}},{alert:{raw:{labels:{ids:["a","b"],limit:2}}},run}),{ids:["a","b"],limit:2});
  assert.throws(()=>nativeArguments(route,{alert:{raw:{}},run}),/缺少/);
  assert.throws(()=>nativeArguments(route,{arguments:{src_ip:"{{alert.srcip}}"}},{validation:true}),/具体值/);
});

test("schema checks required, types, enum, nested objects, arrays and local definitions",()=>{
  assertNativeSchema({src_ip:"192.0.2.1",dst_ip:"198.51.100.1"},trace.parameters);
  for(const value of [{src_ip:"not-ip",dst_ip:"198.51.100.1"},{src_ip:"192.0.2.1"},{src_ip:"192.0.2.1",dst_ip:"198.51.100.1",depth:99},{src_ip:"192.0.2.1",dst_ip:"198.51.100.1",extra:1}])assert.throws(()=>assertNativeSchema(value,trace.parameters));
  const nested={type:"object",properties:{items:{type:"array",items:{$ref:"#/$defs/item"},maxItems:2}},required:["items"],$defs:{item:{type:"object",properties:{mode:{enum:["brief","full"]}},required:["mode"],additionalProperties:false}}};
  assertNativeSchema({items:[{mode:"brief"}]},nested);assert.throws(()=>assertNativeSchema({items:[{mode:"delete"}]},nested),/枚举/);
});

test("explicit native entries expose multiple independent queries without unrelated legacy prefetch",async()=>{
  const h=host(),f=await h.fixture();assert.equal(h.calls.length,0);
  assert.deepEqual(f.agent.restriction.allow,[trace.name,inspect.name]);
  assert.deepEqual(f.record.evidence.dictionary.map(e=>e.lookup.entryId),["route","metric"]);
  const first=await f.lookup({entryId:"route",alertId:"s:1"}),second=await f.lookup({entryId:"metric",alertId:"s:2"});
  assert.equal(first.status,"ok");assert.equal(second.status,"ok");
  assert.deepEqual(h.calls.map(c=>c.arguments),[{src_ip:"192.0.2.10",dst_ip:"198.51.100.20",depth:8},{ip:"198.51.100.30",from:1000}]);
  assert.equal(f.context.toolCallsUsed,2);assert.equal(h.agents.size,1);assert.equal(h.prompts.length,0);
});

test("model cannot supply raw native arguments, unselected entries or another batch's alert",async()=>{
  const h=host(),f=await h.fixture();
  for(const args of [{entryId:"route",alertId:"s:1",arguments:{src_ip:"127.0.0.1"}},{entryId:"other",alertId:"s:1"},{entryId:"route",alertId:"elsewhere"}])await assert.rejects(f.lookup(args));
  assert.equal(h.calls.length,0);
  assert.match(f.agent.guard({agent:f.agent,token:Symbol(),name:trace.name,arguments:{src_ip:"127.0.0.1"},callId:"guess"}),/固定/);
});

test("native result deduplication uses generated arguments and shares the overall budget",async()=>{
  const h=host(),f=await h.fixture({queryPlan:{...task.queryPlan,maxSupplementaryCalls:1}});
  await f.lookup({entryId:"route",alertId:"s:1"});const repeated=await f.lookup({entryId:"route",alertId:"s:3"});
  assert.equal(repeated.reused,true);assert.deepEqual(repeated.alertIds,["s:1","s:3"]);assert.equal(h.calls.length,1);
  assert.equal((await f.lookup({entryId:"metric",alertId:"s:2"})).status,"unavailable");
});

test("explicit empty selection and zero budget do not expose callable lookup capabilities",async()=>{
  for(const queryPlan of [{dictionaryIds:[]},{dictionaryIds:["route"],maxSupplementaryCalls:0}]){
    const h=host(),f=await h.fixture({queryPlan});assert.equal(h.calls.length,0);assert.deepEqual(f.agent.executor.describe([...f.agent.registered.values()]).schemas,[]);
  }
});

test("missing alert fields, schema drift and unverified native entries do not execute or fall back",async()=>{
  for(const entry of [{...route,validation:{status:"unverified"}},{...route,validation:{...route.validation,toolFingerprint:"changed"}}]){
    const h=host(),f=await h.fixture({queryDictionary:[entry,metric]});assert.equal((await f.lookup({entryId:"route",alertId:"s:1"})).status,"unavailable");assert.equal(h.calls.length,0);
  }
  const h=host(),f=await h.fixture();f.record.run={...run,alerts:[{alertId:"empty",raw:{}}]};assert.equal((await f.lookup({entryId:"route",alertId:"empty"})).status,"unavailable");assert.equal(h.calls.length,0);
});

test("native validation uses concrete parameters and visible object response without model prompts",async()=>{
  const h=host({redact:()=>({route:["REDACTED"]})});
  const result=await h.analyze.validateDictionary(route,{workspace:"/ops",sample:{arguments:{src_ip:"192.0.2.10",dst_ip:"198.51.100.20"}}},signal());
  assert.equal(result.status,"verified");assert.deepEqual(result.fields,["route"]);assert.equal(result.rowCount,1);assert.equal(h.prompts.length,0);assert.equal(h.agents.size,1);
  assert.equal(JSON.stringify(result).includes("REDACTED"),false);assert.match(h.titles[0],/MCP字典验证/);
  const a=[...h.agents.values()][0];assert.deepEqual(a.executor.describe([...a.registered.values()]).schemas,[]);
  const bad=await h.analyze.validateDictionary(route,{workspace:"/ops",sample:{arguments:{src_ip:"bad"}}},signal());assert.equal(bad.status,"failed");assert.equal(h.calls.length,1);
});

test("native query honors post-policy redaction, readable text, error responses and truncation",async()=>{
  const h=host({response:()=>({secret:"RAW_SECRET"}),redact:()=>({route:"safe"})}),f=await h.fixture();
  const e=await f.lookup({entryId:"route",alertId:"s:1"});assert.equal(JSON.stringify(e).includes("RAW_SECRET"),false);assert.match(e.rows[0].text,/safe/);
  assert.equal(nativeResult({content:[{type:"text",text:"plain diagnostics"}]}).rowCount,1);
  assert.equal(nativeResult({content:[{type:"text",text:"[]"}]}).rowCount,0);
  assert.equal(nativeResult({content:[{type:"text",text:"x".repeat(6100)}]}).partial,true);
  assert.throws(()=>nativeResult({content:[{type:"text",text:'{"error":"denied"}'}]}),/错误/);
  assert.throws(()=>nativeResult({content:[{type:"image",data:"omitted"}]}),/非文本/);
  assert.throws(()=>nativeResult({content:[{type:"text",text:"字".repeat(700000)}]}),/2 MB/);
});

test("converted legacy path reference becomes native lookup without running the old path template",()=>{
  const d=resolveDictionary({queryPlan:{dictionaryBindings:{paths:"route"}},queryDictionary:[route]},[trace,neo]);
  assert.equal(d.entries.paths.skip,true);assert.equal(d.entries.paths.tool,"");assert.equal(d.byId.route.tool,trace.name);assert.equal(d.evidence[0].lookup.entryId,"route");
});

test("concurrent native duplicates and unrelated requests share the same atomic budget",async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const h=host({response:()=>pending}),f=await h.fixture({queryPlan:{...task.queryPlan,maxSupplementaryCalls:1}});
  const first=f.lookup({entryId:"route",alertId:"s:1"});
  await assert.rejects(f.lookup({entryId:"route",alertId:"s:3"}),/正在执行/);
  assert.equal((await f.lookup({entryId:"metric",alertId:"s:2"})).status,"unavailable");
  release({route:["A"]});assert.equal((await first).status,"ok");assert.equal(h.calls.length,1);assert.equal(f.context.toolCallsUsed,1);
});

test("native cancellation clears permissions and does not retain a false successful result",async()=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  const h=host({response:exec=>new Promise((resolve,reject)=>{entered();exec.signal.addEventListener("abort",()=>reject(exec.signal.reason),{once:true});})}),f=await h.fixture();
  const control=new AbortController(),promise=f.lookup({entryId:"route",alertId:"s:1"},{signal:control.signal});
  await started;control.abort(new Error("cancelled by owner"));await assert.rejects(promise,/cancelled/);
  assert.equal(f.record.permits.size,0);assert.equal(f.record.pendingLookups.size,0);assert.equal(f.record.evidence.queries.length,0);
});

test("code execution schemas and write tools cannot become native query capabilities",async()=>{
  for(const tool of [{name:"fixture_query",parameters:{type:"object",properties:{sql:{type:"string"}}}},{name:"fixture_run",annotations:{readOnlyHint:true},parameters:{type:"object",properties:{}}},{...trace,annotations:{readOnlyHint:false}}]){
    const invalid=entry("route",tool,{id:"constant"}),h=host({schemas:[tool]}),f=await h.fixture({queryPlan:{dictionaryIds:["route"]},queryDictionary:[invalid]});
    assert.equal((await f.lookup({entryId:"route",alertId:"s:1"})).status,"unavailable");assert.equal(h.calls.length,0);
  }
});

test("reference-only selections and format repair do not open native model tools",async()=>{
  const h=host(),reference={id:"reference",name:"Notes",purpose:"reference",document:"Meaning only"};
  const f=await h.fixture({queryPlan:{dictionaryIds:["reference"]},queryDictionary:[reference]});
  assert.equal(f.record.evidence.dictionary[0].status,"reference");assert.equal(h.calls.length,0);assert.deepEqual(f.agent.executor.describe([...f.agent.registered.values()]).schemas,[]);
  const repair=await h.fixture({formatOnly:true});
  assert.deepEqual(repair.agent.executor.describe([...repair.agent.registered.values()]).schemas,[]);
  await assert.rejects(repair.lookup({entryId:"route",alertId:"s:1"}),/当前巡检/);assert.equal(h.calls.length,0);
});
