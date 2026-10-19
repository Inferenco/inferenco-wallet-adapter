// Run against an installed packed consumer, never a source alias.
// node tests/package/packed-exports.mjs /absolute/consumer [--expect-sdk-eventemitter-error]
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
const consumer=resolve(process.argv[2]||'.');
const expectSdkError=process.argv.includes('--expect-sdk-eventemitter-error');
const require=createRequire(join(consumer,'package.json'));
const ts=require('typescript');
const dir=join(consumer,'packed-export-regression');
mkdirSync(dir,{recursive:true});
const names=['@inferenco/infer-wallet-adapter','@inferenco/infer-wallet-adapter/aip62','@inferenco/infer-wallet-adapter/auto-register'];
const esm="import { createInferAIP62Wallet, createInferNativeRecoveryFeatures, type InferNativeRecoveryFeatures } from '@inferenco/infer-wallet-adapter';\nimport { createInferAIP62Wallet as aip, createInferNativeRecoveryFeatures as nativeAip } from '@inferenco/infer-wallet-adapter/aip62';\nimport '@inferenco/infer-wallet-adapter/auto-register';\nconst a=createInferAIP62Wallet(); const b=aip();\nconst n:InferNativeRecoveryFeatures|null=createInferNativeRecoveryFeatures({}, {isCurrent:()=>true});\nif(n){void n['inferenco:recoveredOutcomes'].read; void n['inferenco:transactionSubmission'].signAndSubmitTransaction;}\nvoid a; void b; void nativeAip;\n";
const cjs="import adapter = require('@inferenco/infer-wallet-adapter');\nimport aip = require('@inferenco/infer-wallet-adapter/aip62');\nimport register = require('@inferenco/infer-wallet-adapter/auto-register');\nconst a=adapter.createInferAIP62Wallet(); const b=aip.createInferAIP62Wallet(); const n:adapter.InferNativeRecoveryFeatures|null=adapter.createInferNativeRecoveryFeatures({}, {isCurrent:()=>true}); if(n){void n['inferenco:recoveredOutcomes'].read; void n['inferenco:transactionSubmission'].signAndSubmitTransaction;} void a; void b; void register;\n";
const submissionTypes = `
function checkSubmissionTypes(
  client: import('@inferenco/infer-wallet-adapter').InferClient,
  wallet: import('@inferenco/infer-wallet-adapter').InferWallet,
  raw: import('@cedra-labs/ts-sdk').AnyRawTransaction
) {
  const payload = { function: '0x1::chips::claim_free_chips' as const, functionArguments: [], typeArguments: [] };
  void client.signAndSubmitTransaction(payload);
  void client.signAndSubmitTransaction({ payload });
  void wallet.signAndSubmitTransaction({ data: payload });
  void client.signTransaction(raw);
  void wallet.signTransaction(raw);
  // @ts-expect-error Raw SDK objects are sign-only, not payload submission inputs.
  void client.signAndSubmitTransaction(raw);
  // @ts-expect-error The historical BCS alias does not submit raw SDK objects.
  void client.signAndSubmitBCSTransaction(raw);
  // @ts-expect-error Plugin submission also rejects raw SDK objects.
  void wallet.signAndSubmitTransaction(raw);
  // @ts-expect-error Plugin BCS alias also remains payload-only.
  void wallet.signAndSubmitBCSTransaction(raw);
}
void checkSubmissionTypes;
`;
writeFileSync(join(dir,'consumer.mts'),esm+submissionTypes);
writeFileSync(join(dir,'consumer.cts'),cjs+submissionTypes);
writeFileSync(join(dir,'sdk-only.mts'),"import { Account } from '@cedra-labs/ts-sdk';\nvoid Account;\n");
const resolutions=[];
for(const name of names){
 const row={name};
 for(const [label,mode,ext] of [['import',ts.ModuleKind.ESNext,'.d.ts'],['require',ts.ModuleKind.CommonJS,'.d.cts']]){
  const result=ts.resolveModuleName(name,join(dir,label==='import'?'consumer.mts':'consumer.cts'),{module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext},ts.sys,undefined,undefined,mode).resolvedModule;
  assert.ok(result?.resolvedFileName.endsWith(ext),name+' must resolve '+ext+' through actual exports');
  row[label]=result.resolvedFileName;
 }
 resolutions.push(row);
}
function run(args){
 const result=spawnSync(process.execPath,args,{cwd:consumer,encoding:'utf8'});
 assert.ifError(result.error);
 return {exitCode:result.status,output:result.stdout+result.stderr,args};
}
const tsc=require.resolve('typescript/bin/tsc');
const base=[tsc,'--noEmit','--strict','--target','ES2022'];
const results={
 esmRuntime:run(['--input-type=module','-e','for (const name of '+JSON.stringify(names)+') await import(name);']),
 cjsRuntime:run(['-e','for (const name of '+JSON.stringify(names)+') require(name);']),
 cjsStrict:run([...base,'--module','NodeNext','--moduleResolution','NodeNext',join(dir,'consumer.cts')]),
 bundlerStrict:run([...base,'--module','ESNext','--moduleResolution','Bundler',join(dir,'consumer.mts')]),
 esmStrict:run([...base,'--module','NodeNext','--moduleResolution','NodeNext',join(dir,'consumer.mts')]),
 sdkOnlyStrict:run([...base,'--module','NodeNext','--moduleResolution','NodeNext',join(dir,'sdk-only.mts')])
};
for(const name of ['esmRuntime','cjsRuntime','cjsStrict','bundlerStrict'])assert.equal(results[name].exitCode,0,name+': '+results[name].output);
if(expectSdkError){
 for(const name of ['esmStrict','sdkOnlyStrict']){
  assert.equal(results[name].exitCode,2,name);
  const lines=results[name].output.trim().split('\n');
  assert.equal(lines.length,2,name+' must have only the two documented upstream errors');
  assert.match(lines[0],/api\/transactionSubmission\/management\.d\.mts\(\d+,45\): error TS2507:.*not a constructor function type/);
  assert.match(lines[1],/transactions\/management\/transactionWorker\.d\.mts\(\d+,41\): error TS2507:.*not a constructor function type/);
 }
 assert.equal(results.esmStrict.output,results.sdkOnlyStrict.output,'SDK-only import must reproduce every strict ESM diagnostic');
}else{
 assert.equal(results.esmStrict.exitCode,0,results.esmStrict.output);
 assert.equal(results.sdkOnlyStrict.exitCode,0,results.sdkOnlyStrict.output);
}
const adapterPackage=JSON.parse(readFileSync(join(dirname(require.resolve(names[0])),'..','package.json'),'utf8'));
const output={adapterVersion:adapterPackage.version,sdkVersion:JSON.parse(readFileSync(require.resolve('@cedra-labs/ts-sdk/package.json'),'utf8')).version,typescript:ts.version,resolutions,results,cjsPackagingRegression:'passed',strictEsmQualification:expectSdkError?'FAILED: explicitly reproduced upstream SDK EventEmitter declarations':'passed'};
writeFileSync(join(dir,'result.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({sdk:output.sdkVersion,cjsPackagingRegression:output.cjsPackagingRegression,strictEsmQualification:output.strictEsmQualification,result:join(dir,'result.json')},null,2));
