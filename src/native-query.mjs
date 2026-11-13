import { isIP } from "node:net";
import { normalizeDictionaryRecipe } from "./dictionary-defs.mjs";

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
export function nativeArguments(entry, { alert, run, arguments: sample } = {}, { validation = false } = {}) {
  const template = normalizeDictionaryRecipe("tool", { arguments: validation ? sample : entry.recipe?.arguments }).arguments;
  const raw = plain(alert?.raw) ? alert.raw : {}, labels = { ...(plain(raw.labels) ? raw.labels : {}) };
  for (const tag of [...(Array.isArray(raw.original_tags) ? raw.original_tags : []), ...(Array.isArray(raw.tags) ? raw.tags : [])]) {
    if (typeof tag !== "string") continue;
    const at = tag.indexOf("="); if (at > 0 && !forbidden.has(tag.slice(0,at))) labels[tag.slice(0,at)] = tag.slice(at+1);
  }
  const pick = (key) => {
    let value;
    const aliases = {
      "alert.srcip": labels.srcip ?? labels.src_ip ?? raw.srcip ?? raw.src_ip,
      "alert.dstip": labels.dstip ?? labels.dst_ip ?? raw.dstip ?? raw.dst_ip ?? labels.target ?? raw.target,
      "alert.ip": labels.ip ?? labels.ip_address ?? raw.ip ?? raw.ip_address ?? (isIP(alert?.host ?? "") ? alert.host : undefined),
      "alert.host": alert?.host, "alert.title": alert?.title,
      "window.start": run?.start, "window.end": run?.end,
      "window.startIso": Number.isSafeInteger(run?.start) ? new Date(run.start).toISOString() : undefined,
      "window.endIso": Number.isSafeInteger(run?.end) ? new Date(run.end).toISOString() : undefined,
      "window.startSeconds": Number.isSafeInteger(run?.start) ? run.start / 1000 : undefined,
      "window.endSeconds": Number.isSafeInteger(run?.end) ? run.end / 1000 : undefined,
    };
    if (Object.hasOwn(aliases,key)) value = aliases[key];
    else if (/^alert\.labels\.[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key)) {
      const field = key.slice(13);
      if (forbidden.has(field) || /token|password|secret|credential|authorization|api_?key/i.test(field)) throw new Error("参数占位符不能读取凭据字段");
      if (Object.hasOwn(labels,field)) value = labels[field];
    }
    else throw new Error(`不支持的参数占位符：${key}`);
    if (value === undefined || value === null || value === "") throw new Error(`当前告警缺少参数来源：${key}`);
    if (["alert.srcip","alert.dstip","alert.ip"].includes(key) && !isIP(value)) throw new Error(`告警参数不是有效 IP：${key}`);
    return structuredClone(value);
  };
  const expand = (value) => {
    if (typeof value === "string") {
      if (validation) { if (value.includes("{{")) throw new Error("验证参数须填写具体值，不能保留占位符"); return value; }
      const whole = /^\{\{([^{}]+)\}\}$/.exec(value);
      if (whole) return pick(whole[1].trim());
      const out = value.replace(/\{\{([^{}]+)\}\}/g, (_,key) => { const v = pick(key.trim()); if (typeof v === "object") throw new Error("数组或对象占位符必须单独作为参数值"); return String(v); });
      if (out.includes("{{") || out.includes("}}")) throw new Error("参数占位符格式无效");
      return out;
    }
    if (Array.isArray(value)) return value.map(expand);
    if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key,v]) => [key,expand(v)]));
    return value;
  };
  // Recheck size, forbidden keys and data types after values were expanded.
  return normalizeDictionaryRecipe("tool", { arguments: expand(template) }).arguments;
}

export function assertNativeSchema(value, schema = {}) {
  const root = schema; let operations = 0;
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  function check(v,s,path,depth) {
    if (++operations > 10000 || depth > 18) throw new Error("MCP 参数结构过于复杂");
    if (s === true) return; if (s === false) throw new Error(`${path} 不接受此参数`);
    if (!plain(s)) throw new Error("MCP 参数结构无效");
    if (s.$ref) {
      if (typeof s.$ref !== "string" || !s.$ref.startsWith("#/")) throw new Error("不支持外部 MCP 参数结构引用");
      let ref = root;
      for (const segment of s.$ref.slice(2).split("/")) { const key=segment.replaceAll("~1","/").replaceAll("~0","~"); if (forbidden.has(key) || !plain(ref) || !Object.hasOwn(ref,key)) throw new Error("MCP 参数结构引用不存在"); ref=ref[key]; }
      check(v,ref,path,depth+1);
    }
    for (const key of ["allOf","anyOf","oneOf"]) if (s[key]) {
      if (!Array.isArray(s[key]) || !s[key].length || s[key].length>20) throw new Error("MCP 参数分支无效");
      let matched=0;
      for (const branch of s[key]) { try { check(v,branch,path,depth+1); matched++; } catch(error) { if (operations>10000) throw error; } }
      if (key==="allOf" ? matched!==s[key].length : key==="oneOf" ? matched!==1 : matched===0) throw new Error(`${path} 不符合 MCP 参数分支`);
    }
    if (s.not) { let matched=false; try { check(v,s.not,path,depth+1); matched=true; } catch {} if (matched) throw new Error(`${path} 不符合 MCP 参数约束`); }
    if (Object.hasOwn(s,"const") && !equal(v,s.const) || Array.isArray(s.enum) && !s.enum.some(x=>equal(v,x))) throw new Error(`${path} 不符合枚举值`);
    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    const match = (type) => type==="null" ? v===null : type==="object" ? plain(v) : type==="array" ? Array.isArray(v) : type==="integer" ? Number.isSafeInteger(v) : type==="number" ? typeof v==="number"&&Number.isFinite(v) : typeof v===type;
    if(types.length && !types.some(match)) throw new Error(`${path} 参数类型不匹配`);
    if(plain(v)) {
      if ((s.required ?? []).some(key=>!Object.hasOwn(v,key))) throw new Error(`${path} 缺少必填参数`);
      if (s.maxProperties!==undefined && Object.keys(v).length>s.maxProperties || s.minProperties!==undefined && Object.keys(v).length<s.minProperties) throw new Error(`${path} 参数字段数量不符`);
      for(const [key,item] of Object.entries(v)) {
        if(forbidden.has(key)) throw new Error("无效参数字段");
        if(Object.hasOwn(s.properties??{},key)) check(item,s.properties[key],`${path}.${key}`,depth+1);
        else if(s.additionalProperties===false) throw new Error(`${path}.${key} 不在 MCP 参数结构中`);
        else if(plain(s.additionalProperties)) check(item,s.additionalProperties,`${path}.${key}`,depth+1);
      }
    }
    if(Array.isArray(v)) {
      if(s.minItems!==undefined&&v.length<s.minItems || s.maxItems!==undefined&&v.length>s.maxItems) throw new Error(`${path} 数组数量不符`);
      if(s.uniqueItems && new Set(v.map(x=>JSON.stringify(x))).size!==v.length) throw new Error(`${path} 数组含重复值`);
      v.forEach((item,i)=>{const rule=s.prefixItems?.[i]??s.items; if(rule!==undefined) check(item,rule,`${path}[${i}]`,depth+1);});
    }
    if(typeof v==="string") {
      if(s.minLength!==undefined&&v.length<s.minLength || s.maxLength!==undefined&&v.length>s.maxLength) throw new Error(`${path} 文本长度不符`);
      if(s.pattern && !new RegExp(s.pattern,"u").test(v)) throw new Error(`${path} 不符合参数格式`);
      if(s.format==="ipv4" && isIP(v)!==4 || s.format==="ipv6" && isIP(v)!==6 || s.format==="date-time" && !Number.isFinite(Date.parse(v))) throw new Error(`${path} 格式无效`);
    }
    if(typeof v==="number" && (s.minimum!==undefined&&v<s.minimum || s.maximum!==undefined&&v>s.maximum || typeof s.exclusiveMinimum==="number"&&v<=s.exclusiveMinimum || typeof s.exclusiveMaximum==="number"&&v>=s.exclusiveMaximum)) throw new Error(`${path} 数值越界`);
  }
  check(value,schema,"arguments",0);
}

// Uses only post-policy visible content. Do not reconstruct redacted raw values.
export function nativeResult(result) {
  const blocks=(result.content??[]).filter(b=>b?.type==="text"&&typeof b.text==="string");
  const text=blocks.map(b=>b.text).join("\n").trim();
  if(Buffer.byteLength(text,"utf8")>2000000) throw new Error("MCP 返回内容超过 2 MB");
  if(!text && blocks.length!==(result.content??[]).length) throw new Error("MCP 仅返回不可读的非文本内容，无法验证查询结果");
  let value; try { value=JSON.parse(text); } catch {}
  if(plain(value) && (value.isError===true || value.error)) throw new Error("MCP 返回错误内容，未标记查询成功");
  const empty=!text || value===null || (Array.isArray(value)&&!value.length) || (plain(value)&&!Object.keys(value).length);
  return { rows: empty?[]:[{text:text.slice(0,6000)}], rowCount: empty?0:Array.isArray(value)?value.length:1,
    fields: plain(value)?Object.keys(value).slice(0,40):[], partial:text.length>6000||blocks.length!==(result.content??[]).length };
}
