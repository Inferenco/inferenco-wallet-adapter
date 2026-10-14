import { Account } from '@cedra-labs/ts-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as publicApi from '../src/aip62';
import { InferClient } from '../src/InferClient';
import { canonicalAddress, normalizeSubmitInput } from '../src/integrationContract';
import { getDurableInvocation } from '../src/durableRecovery';
import * as durable from '../src/durableRecovery';

const signer = Account.generate();
const hash = '0x' + 'ab'.repeat(32);
const wire = () => normalizeSubmitInput({
  sender: signer.accountAddress.toString(), chainId: 2,
  data: {function:'0x1::fixture::run',typeArguments:[],functionArguments:[]},
  options:{expireTimestamp:Math.floor(Date.now()/1000)+300}
});
const clients: Array<{dispose():void}> = [];
function fixture() {
  let metadata:any;
  let selected = true;
  let network = {name:'testnet',chainId:2};
  let address: string = signer.accountAddress.toString();
  let result: any = null;
  const accountListeners:Array<()=>void>=[];
  const networkListeners:Array<()=>void>=[];
  const submit=vi.fn(async (_:unknown, meta:unknown)=>{metadata=meta;return {hash};});
  const read=vi.fn(async ()=>result ?? {...metadata,method:'signAndSubmitTransaction',status:'approved',payload:{hash}});
  const ack=vi.fn(async ()=>({...metadata,method:'signAndSubmitTransaction',requestId:'native-receipt',status:'acknowledged'}));
  const wallet:any={
    name:'Infer Wallet',integrationContractVersion:1,
    capabilities:{transactionRestrictions:true,durableInvocationLookup:true,durableInvocationSubmission:true},
    signAndSubmitTransaction:submit,readInvocation:read,acknowledgeInvocation:ack,
    features:{
      'cedra:onAccountChange':{version:'1.0.0',onAccountChange:(fn:()=>void)=>{accountListeners.push(fn);return Promise.resolve(()=>{});}},
      'cedra:onNetworkChange':{version:'1.0.0',onNetworkChange:(fn:()=>void)=>{networkListeners.push(fn);return Promise.resolve(()=>{});}},
      'cedra:account':{version:'1.0.0',account:vi.fn(async()=>({address,publicKey:signer.publicKey.toUint8Array()}))},
      'cedra:network':{version:'1.0.0',network:vi.fn(async()=>network)},
      'cedra:signAndSubmitTransaction':{version:'1.1.0',signAndSubmitTransaction:vi.fn()}
    }
  };
  const factory=(publicApi as any).createInferNativeRecoveryFeatures;
  const create=()=>{
    expect(factory).toBeTypeOf('function');
    const features=factory(wallet,{isCurrent:()=>selected});
    if(features)clients.push(features);
    return features;
  };
  return {wallet,submit,read,ack,create,
    metadata:()=>metadata, select:(v:boolean)=>{selected=v;},
    network:(v:typeof network)=>{network=v;for(const fn of networkListeners)fn();}, address:(v:string)=>{address=v;for(const fn of accountListeners)fn();},
    result:(v:any)=>{result=v;}
  };
}
afterEach(()=>{for(const client of clients.splice(0))client.dispose();delete (window as any).inferenco;vi.restoreAllMocks();});

describe('selected registered native recovery features',()=>{
  it('does not adopt ordinary or incompatible wallets',()=>{
    const f=fixture(); f.wallet.integrationContractVersion=2;
    expect(f.create()).toBeNull();
    f.wallet.integrationContractVersion=1; delete f.wallet.readInvocation;
    expect(f.create()).toBeNull();
  });
  it('uses the selected wallet and awaits protected persistence before dispatch',async()=>{
    const f=fixture(); const features=f.create();
    const ambient=vi.fn(); (window as any).inferenco={signAndSubmitTransaction:ambient};
    const order:string[]=[];
    const output=await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{
      onInvocationPrepared:async(d:any)=>{
        order.push('prepared');
        expect(f.submit).not.toHaveBeenCalled();
        const row=await getDurableInvocation(d.invocationId);
        expect(row?.requestCommitment).toBe(d.requestCommitment);
        order.push('persisted');
      }
    });
    expect(output).toEqual({status:'Approved',args:{hash}});
    expect(order).toEqual(['prepared','persisted']);
    expect(f.submit).toHaveBeenCalledOnce();expect(ambient).not.toHaveBeenCalled();
  });
  it('produces exact not-invoked evidence when preparation persistence fails',async()=>{
    const f=fixture(), features=f.create();let descriptor:any;
    let error:any;try{await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{
      onInvocationPrepared:(d:any)=>{descriptor=d;throw new Error('persist failed');}
    });}catch(e){error=e;}
    expect(f.submit).not.toHaveBeenCalled();
    expect(features['inferenco:transactionSubmission'].isNotInvoked(error,descriptor)).toBe(true);
    expect(features['inferenco:transactionSubmission'].isNotInvoked({...error},descriptor)).toBe(false);
  });
  it.each(['selection','network','account','capability'])('fences %s changes after preparation',async(change)=>{
    const f=fixture(), features=f.create();let descriptor:any;let error:any;
    try{await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{
      onInvocationPrepared:(d:any)=>{
        descriptor=d;
        if(change==='selection')f.select(false);
        if(change==='network')f.network({name:'testnet',chainId:3});
        if(change==='account')f.address(Account.generate().accountAddress.toString());
        if(change==='capability')f.wallet.capabilities.durableInvocationSubmission=false;
      }
    });}catch(e){error=e;}
    expect(f.submit).not.toHaveBeenCalled();
    expect(features['inferenco:transactionSubmission'].isNotInvoked(error,descriptor)).toBe(true);
  });
  it('recovers a lost response using a recreated wrapper, with explicit retryable acknowledgement',async()=>{
    const f=fixture(), features=f.create();
    f.submit.mockImplementation(async(_:unknown,meta:unknown)=>{(f as any).saved=meta;throw new Error('dropped');});
    let descriptor:any;
    await expect(features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{
      onInvocationPrepared:(d:any)=>{descriptor=d;}
    })).rejects.toMatchObject({code:'REQUEST_OUTCOME_UNKNOWN'});
    const meta=(f as any).saved;
    f.result({...meta,method:'signAndSubmitTransaction',status:'approved',payload:{hash}});
    features.dispose();
    const next=f.create()['inferenco:recoveredOutcomes'];
    const recovered=await next.read('invocation:'+descriptor.invocationId);
    expect(recovered).toMatchObject({status:'approved',output:{hash},invocationId:descriptor.invocationId});
    expect(f.ack).not.toHaveBeenCalled();
    f.ack.mockImplementation(async()=>({...meta,requestId:'native-receipt',method:'signAndSubmitTransaction',status:'acknowledged'}));
    f.ack.mockRejectedValueOnce(new Error('ack lost'));
    await expect(next.acknowledge(recovered.recoveryId)).rejects.toThrow();
    expect(await next.list()).toHaveLength(1);
    await next.acknowledge(recovered.recoveryId);
    await next.acknowledge(recovered.recoveryId);
    expect(await next.list()).toHaveLength(0);
    expect(f.submit).toHaveBeenCalledOnce();
  });
  it.each(['pending','unknown'])('retains transactionHash from a %s wallet outcome without execution',async(status)=>{
    const f=fixture(), features=f.create();let descriptor:any;
    await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(d:any)=>{descriptor=d;}});
    // A second unresolved invocation supplies the actual native lookup boundary.
    f.submit.mockRejectedValueOnce(new Error('dropped'));
    await expect(features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(d:any)=>{descriptor=d;}})).rejects.toThrow();
    // Metadata for the failed dispatch is retained by fixture submit override below.
    const row=await getDurableInvocation(descriptor.invocationId);
    const scope={origin:row!.origin,accountAddress:canonicalAddress(row!.address),network:row!.network,chainId:row!.chainId};
    f.result({contractVersion:1,invocationId:row!.id,requestCommitment:row!.requestCommitment,scope,method:row!.method,status,transactionHash:hash});
    expect(await features['inferenco:recoveredOutcomes'].read('invocation:'+row!.id)).toMatchObject({status,transactionHash:hash});
    expect(f.ack).not.toHaveBeenCalled();
  });
  it('offers compatible lookup when new durable submission is unsupported',async()=>{
    const f=fixture();f.wallet.capabilities.durableInvocationSubmission=false;
    const features=f.create();expect(features.canSubmit()).toBe(false);
    await expect(features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire())).rejects.toThrow();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('rejects foreign recovery handles without external transport fallback',async()=>{
    const f=fixture(), features=f.create();
    await expect(features['inferenco:recoveredOutcomes'].read('desktop:foreign')).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
  });
  it('does not expose a cached terminal result after the selected scope changes',async()=>{
    const f=fixture(), features=f.create();let descriptor:any;
    await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(d:any)=>{descriptor=d;}});
    f.select(false);
    await expect(features['inferenco:recoveredOutcomes'].read('invocation:'+descriptor.invocationId)).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
  });
  it('revalidates the native grant before publishing a cached terminal receipt',async()=>{
    const f=fixture(),features=f.create();let d:any;
    await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(v:any)=>{d=v;}});
    f.read.mockRejectedValueOnce(new Error('grant revoked'));
    expect(await features['inferenco:recoveredOutcomes'].read('invocation:'+d.invocationId)).toMatchObject({status:'unknown'});
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
  });
  it('coalesces concurrent exact native reads and fences each consumer',async()=>{
    const f=fixture(),features=f.create();let d:any;
    f.submit.mockRejectedValueOnce(new Error('lost'));
    await expect(features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(v:any)=>{d=v;}})).rejects.toThrow();
    const row=await getDurableInvocation(d.invocationId);
    let finish:(v:unknown)=>void=()=>{};
    f.read.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const a=features['inferenco:recoveredOutcomes'].read('invocation:'+d.invocationId);
    const b=features['inferenco:recoveredOutcomes'].read('invocation:'+d.invocationId);
    await vi.waitFor(()=>expect(f.read).toHaveBeenCalledOnce());
    finish({contractVersion:1,invocationId:row!.id,requestCommitment:row!.requestCommitment,
      scope:{origin:row!.origin,accountAddress:canonicalAddress(row!.address),network:row!.network,chainId:row!.chainId},
      method:row!.method,status:'approved',payload:{hash}});
    expect(await a).toMatchObject({status:'approved',output:{hash}});
    expect(await b).toMatchObject({status:'approved',output:{hash}});
    expect(f.ack).not.toHaveBeenCalled();
  });
  it('withholds a late read after the selected account changes',async()=>{
    const f=fixture(),features=f.create();let d:any;
    f.submit.mockRejectedValueOnce(new Error('lost'));
    await expect(features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(v:any)=>{d=v;}})).rejects.toThrow();
    let finish:(v:unknown)=>void=()=>{};f.read.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const reading=features['inferenco:recoveredOutcomes'].read('invocation:'+d.invocationId);
    const rejected=expect(reading).rejects.toThrow();
    await vi.waitFor(()=>expect(f.read).toHaveBeenCalledOnce());
    f.address(Account.generate().accountAddress.toString());
    finish({...f.metadata(),method:'signAndSubmitTransaction',status:'approved',payload:{hash}});
    await rejected;
    expect((await getDurableInvocation(d.invocationId))?.final).toBeUndefined();
  });
  it('withholds a late approval after the selected wallet changes',async()=>{
    const f=fixture(),features=f.create();let finish:(v:{hash:string})=>void=()=>{};
    f.submit.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const request=features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire());
    const rejected=expect(request).rejects.toMatchObject({code:'REQUEST_OUTCOME_UNKNOWN'});
    await vi.waitFor(()=>expect(f.submit).toHaveBeenCalledOnce());
    f.select(false);finish({hash});await rejected;
  });

  it('rejects a mixed account snapshot when account changes during the network read',async()=>{
    const f=fixture(),features=f.create();let d:any;
    await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(v:any)=>{d=v;}});
    let waiting=false;
    let finish:(v:unknown)=>void=()=>{};
    f.wallet.features['cedra:network'].network.mockImplementationOnce(()=>new Promise(resolve=>{waiting=true;finish=resolve;}));
    const reading=features['inferenco:recoveredOutcomes'].read('invocation:'+d.invocationId);
    const rejected=expect(reading).rejects.toThrow();
    await vi.waitFor(()=>expect(waiting).toBe(true));
    f.address(Account.generate().accountAddress.toString());
    finish({name:'testnet',chainId:2});
    await rejected;
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([
    {chainStatus:['confirmed']},
    {submissionAcceptance:['accepted']},
    {chainStatus:'confirmed',chainVersion:'01'},
    {chainStatus:'confirmed',chainVersion:'18446744073709551616'},
    {submissionAcceptance:'unknown'}
  ])('rejects malformed native execution evidence %j',async(patch)=>{
    const f=fixture(),features=f.create();let d:any;
    await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(v:any)=>{d=v;}});
    f.result({...f.metadata(),method:'signAndSubmitTransaction',status:'approved',payload:{hash},...patch});
    expect(await features['inferenco:recoveredOutcomes'].read('invocation:'+d.invocationId)).toMatchObject({status:'unknown'});
    expect(f.ack).not.toHaveBeenCalled();
  });

  it('does not dispatch an old preparation after an account round trip',async()=>{
    const f=fixture(),features=f.create();let descriptor:any;let error:any;
    try{await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{
      onInvocationPrepared:(d:any)=>{
        descriptor=d;
        f.address(Account.generate().accountAddress.toString());
        f.address(signer.accountAddress.toString());
      }
    });}catch(e){error=e;}
    expect(f.submit).not.toHaveBeenCalled();
    expect(features['inferenco:transactionSubmission'].isNotInvoked(error,descriptor)).toBe(true);
  });

  it('stops before dispatch when the adapter invocation cannot be persisted',async()=>{
    const f=fixture(),features=f.create(),prepare=vi.fn();
    vi.spyOn(durable,'prepareDurableInvocation').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:prepare})).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it.each([false,true])('recovers after a failed final write (write may have committed: %s)',async(committed)=>{
    const f=fixture(),features=f.create();let d:any;
    const original=durable.updateInjectedInvocationEvidence;
    vi.spyOn(durable,'updateInjectedInvocationEvidence').mockImplementationOnce(async(...args)=>{
      if(committed)await original(...args);
      throw new Error('result write uncertain');
    });
    await expect(features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(v:any)=>{d=v;}})).rejects.toMatchObject({code:'REQUEST_OUTCOME_UNKNOWN'});
    expect(await features['inferenco:recoveredOutcomes'].read('invocation:'+d.invocationId)).toMatchObject({status:'approved',output:{hash}});
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.ack).not.toHaveBeenCalled();
  });
  it('retains known signed identity from an uncertain native error without leaking its text',async()=>{
    const f=fixture(),features=f.create();let d:any;
    const nativeError=Object.assign(new Error('PRIVATE signed material'),{transactionHash:hash,payload:'PRIVATE'});
    f.submit.mockRejectedValueOnce(nativeError);
    let caught:any;
    try{await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire(),{onInvocationPrepared:(v:any)=>{d=v;}});}catch(e){caught=e;}
    expect(caught.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(JSON.stringify(caught)+caught.message).not.toContain('PRIVATE');
    expect((await getDurableInvocation(d.invocationId))?.transactionHash).toBe(hash);
    expect(f.ack).not.toHaveBeenCalled();
  });

  it('does not dispatch a second request under a conflicting generated invocation ID',async()=>{
    const f=fixture(),features=f.create();
    vi.spyOn(globalThis.crypto,'getRandomValues').mockImplementation((array:any)=>{array.fill(17);return array;});
    await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire());
    const changed=wire();changed.data.function='0x1::fixture::different';
    await expect(features['inferenco:transactionSubmission'].signAndSubmitTransaction(changed)).rejects.toThrow();
    expect(f.submit).toHaveBeenCalledOnce();
  });
  it('fences a subscription result across the final asynchronous retention check',async()=>{
    const f=fixture(),features=f.create();
    await features['inferenco:transactionSubmission'].signAndSubmitTransaction(wire());
    const original=InferClient.prototype.listRecoverableRequests;
    let crossed=false;
    vi.spyOn(InferClient.prototype,'listRecoverableRequests').mockImplementation(async function(this:InferClient){
      const rows=await original.call(this);
      if(f.read.mock.calls.length>0 && !crossed){
        crossed=true;
        f.address(Account.generate().accountAddress.toString());f.address(signer.accountAddress.toString());
        f.read.mockRejectedValue(new Error('new generation unavailable'));
      }
      return rows;
    });
    const callback=vi.fn();
    const unsubscribe=features['inferenco:recoveredOutcomes'].subscribe(callback);
    await vi.waitFor(()=>expect(crossed).toBe(true));
    // Wait for the failed first coordinator and a coalesced wake to settle.
    await vi.waitFor(()=>expect(f.read.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(callback).not.toHaveBeenCalled();
    unsubscribe();
  });
  it('withholds a subscription result when wallet events arrive after its final scope read',async()=>{
    const f=fixture();
    let notify: ((outcome:any)=>Promise<void>) | undefined;
    vi.spyOn(InferClient.prototype,'subscribeRecoveredOutcomes').mockImplementation(callback=>{
      notify=async outcome=>{await callback(outcome);};
      return ()=>{};
    });
    f.wallet.features['cedra:network'].network.mockImplementation(async()=>{
      // The scope read completes before the native event is delivered, while
      // the application's subscription callback has not resumed yet.
      queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>{
        f.network({name:'testnet',chainId:3});
        f.network({name:'testnet',chainId:2});
      })));
      return {name:'testnet',chainId:2};
    });
    const features=f.create();
    const callback=vi.fn();
    const unsubscribe=features['inferenco:recoveredOutcomes'].subscribe(callback);
    let error:any;
    try {
      await notify!({status:'approved',origin:window.location.origin,
        address:signer.accountAddress.toString(),network:'testnet',chainId:2});
    } catch(cause) { error=cause; }
    expect(callback).not.toHaveBeenCalled();
    expect(error).toMatchObject({message:'native-wallet-generation-changed'});
    unsubscribe();
  });


});
