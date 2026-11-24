import assert from "node:assert/strict";
import test from "node:test";
import { decodeDisplayResult, engineJSON } from "../web/result-json.js";

const features = Array.from({ length: 3200 }, (_, i) => ({
  type: "Feature", id:"N"+i, properties:{fid:"N"+i, group:0},
  geometry:{type:"Point",coordinates:[i/1000,0]},
  tags:{name:'x},{"type":"Feature","id":'+i, note:"ß".repeat(160)},
}));
const value = { features, limited:"features", outputs:[{ name:"roads", counts:{ total:3200 } }] };
const text = JSON.stringify(value);

test("display transport preserves feature order, escaped strings, groups and limits through batches", async () => {
  const bytes = new TextEncoder().encode(text);
  const api={memory:{buffer:bytes.buffer},output_ptr:()=>0};
  assert.deepEqual(engineJSON(api,bytes.length,true),{resultJSON:text});
  let yields=0;
  const result=await decodeDisplayResult(text,()=>{yields++;return true;});
  assert(yields>0);
  assert.deepEqual(result,value);
  assert.deepEqual(engineJSON(api,bytes.length),value);
});

test("a superseded decode yields no partial result, and errors and other output shapes parse normally", async () => {
  assert.equal(await decodeDisplayResult(text,()=>false),null);
  const error='{"error":"'+ "missing ".repeat(25000)+'"}';
  const bytes=new TextEncoder().encode(error);
  assert.equal(engineJSON({memory:bytes,output_ptr:()=>0},bytes.length,true).error,JSON.parse(error).error);
  const nested={features:[{nested:features}],counts:{total:1}};
  assert.deepEqual(await decodeDisplayResult(JSON.stringify(nested),()=>true),nested);
});
