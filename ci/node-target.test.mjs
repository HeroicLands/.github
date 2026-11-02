// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {parse} from 'yaml';
const root=new URL('../',import.meta.url);
const files=fs.readdirSync(new URL('.gitea/workflows/',root)).filter(f=>f.endsWith('.yml'));
const workflows=files.map(file=>({file,data:parse(fs.readFileSync(new URL('.gitea/workflows/'+file,root),'utf8'))}));
const defaults=workflows.flatMap(({file,data})=>['workflow_call','workflow_dispatch'].flatMap(event=>data.on?.[event]?.inputs?.['node-version']?[{file,event,input:data.on[event].inputs['node-version']}]:[]));
const fallback="${{ vars.CI_NODE_VERSION || '24' }}";
const requested="${{ inputs.node-version || vars.CI_NODE_VERSION || '24' }}";
// These expressions use only the documented string/OR subset shared by both forges.
function evaluate(value,{input='',variable=''}={}){
 const terms=value.replace(/^\$\{\{\s*|\s*\}\}$/g,'').split(/\s*\|\|\s*/);
 return terms.map(term=>term==='inputs.node-version'?input:term==='vars.CI_NODE_VERSION'?variable:term==="'24'"?'24':assert.fail('unsupported target expression '+term)).find(Boolean)??'';
}
test('all declared shared Node defaults use the central target or an empty dispatch sentinel',()=>{
 assert(defaults.some(d=>d.event==='workflow_call'));assert(defaults.some(d=>d.event==='workflow_dispatch'));
 for(const {file,event,input}of defaults){assert.equal(input.type,'string',file);assert.equal(input.required,false,file);assert.equal(input.default,event==='workflow_call'?fallback:'',file);}
});
test('every setup-node consumer and runner-major guard resolves the same target',()=>{
 for(const {file,data}of workflows)for(const job of Object.values(data.jobs??{}))for(const step of job.steps??[]){
  if(step.uses?.startsWith('actions/setup-node@'))assert.equal(step.with?.['node-version'],data.on?.workflow_call?.inputs?.['node-version']?requested:fallback,file);
  if(step.env?.NODE_VERSION!==undefined)assert.equal(step.env.NODE_VERSION,requested,file);
 }
});
test('declared expressions preserve default, override, missing-variable and unsupported-major cases',()=>{
 for(const {event,input}of defaults)for(const values of [{variable:'26',expected:'26'},{input:'24',variable:'26',expected:'24'},{input:'26',variable:'24',expected:'26'},{expected:'24'},{input:'99',variable:'26',expected:'99'}]){
  const defaulted=values.input||evaluate(input.default||requested,values);
  assert.equal(evaluate(requested,{...values,input:defaulted}),values.expected,event);
 }
});
test('the actual Foundry release runner guard accepts matching majors and refuses mismatches',t=>{
 const workflow=workflows.find(w=>w.file==='release-foundry-package.yml').data;
 const step=Object.values(workflow.jobs).flatMap(j=>j.steps??[]).find(s=>s.run?.includes('node_major=$(node -p'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shared-node-guard-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'node'),'#!/bin/sh\nprintf "%s\\n" "$TEST_NODE_MAJOR"\n',{mode:0o755});
 for(const tool of ['npm','typst','jq'])fs.writeFileSync(path.join(dir,tool),'#!/bin/sh\nexit 0\n',{mode:0o755});
 for(const [actual,target,pass]of [['24','24',true],['26','26',true],['24','26',false],['26','24',false],['26','99',false]]){
  const result=spawnSync('bash',['-eu','-c',step.run],{env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,TEST_NODE_MAJOR:actual,NODE_VERSION:target},encoding:'utf8'});assert.equal(result.status,pass?0:1,result.stdout+result.stderr);
 }
});
test('job image pins the official two-architecture Node release and tag-three e2e base',()=>{
 const release=JSON.parse(fs.readFileSync(new URL('fixtures/node26-release.json',import.meta.url)));
 assert.match(release.version,/^v26\.\d+\.\d+$/);assert(release.lts);assert.equal(release.index,'https://nodejs.org/dist/index.json');
 const recipe=fs.readFileSync(new URL('runners/image/Dockerfile',root),'utf8');const args=Object.fromEntries([...recipe.matchAll(/^ARG (NODE_\w+)=(.+)$/gm)].map(m=>[m[1],m[2]]));
 assert.equal(args.NODE_VERSION,release.version.slice(1));for(const [arch,nodeArch]of [['AMD64','x64'],['ARM64','arm64']])assert.equal(args['NODE_SHA256_'+arch],release.sha256[`node-${release.version}-linux-${nodeArch}.tar.xz`]);
 assert.match(recipe,/sha256sum --check --status/);assert.match(recipe,/https:\/\/nodejs\.org\/dist\/v\$\{NODE_VERSION\}\/node-v\$\{NODE_VERSION\}-linux-\$\{node_arch\}\.tar\.xz/);
 assert.match(fs.readFileSync(new URL('runners/image/Dockerfile.e2e',root),'utf8'),/^ARG BASE=heroiclands\/ci-job:3$/m);
});
