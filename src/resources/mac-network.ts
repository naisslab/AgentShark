import {spawn,type ChildProcessWithoutNullStreams}from'node:child_process';
import{setPriority}from'node:os';

/** Keep one PID-filtered nettop process; retain one complete frame, never an unbounded output queue. */
export function macNetworkCollector<T>(parse:(text:string)=>T[], helper:()=>string|undefined) {
 let child:ChildProcessWithoutNullStreams|undefined,key='',wide=false,closed=false,partial='',frame='',stamp=0,at=0;
 let ready:{rows:T[];ts:number;at:number}|undefined;
 let waiting:{resolve(v:{rows:T[];ts:number;at:number}):void;reject(e:Error):void;timer:NodeJS.Timeout}|undefined;
 const failure=()=>new Error('Process network collector unavailable');
 const fail=()=>{if(waiting){clearTimeout(waiting.timer);waiting.reject(failure());waiting=undefined;}};
 const stop=()=>{fail();const proc=child;child=undefined;if(proc){proc.stdin.end();proc.kill('SIGTERM');const timer=setTimeout(()=>proc.kill('SIGKILL'),1000).unref();proc.once('exit',()=>clearTimeout(timer));}partial='';frame='';ready=undefined;};
 const collect=async(pids:number[])=>{
  if(closed||!pids.length)throw failure();
  const next=pids.slice().sort((a,b)=>a-b).join(',');
  if(child&&wide&&next!==key){
   // The global summary already sees new children. Change its bounded filter
   // without restarting nettop or losing counters for surviving processes.
   key=next;partial='';frame='';ready=undefined;
   child.stdin.write(pids.join(' ')+'\n');
  }
  if(!child||next!==key){
   stop();key=next;
   const path=helper();if(!path)throw failure();
   wide=pids.length>20;
   const proc=spawn(path,[wide?'--network-live':'--network',...pids.map(String)],{stdio:['pipe','pipe','pipe'],env:{...process.env,LC_ALL:'C',TZ:'UTC'}});
   child=proc;if(proc.pid)try{setPriority(proc.pid,19);}catch{}
   proc.stderr.resume();proc.stdin.on('error',()=>{if(child===proc)fail();});proc.once('error',()=>{if(child===proc)fail();});proc.once('exit',()=>{if(child===proc){child=undefined;fail();}});
   proc.stdout.setEncoding('utf8');
   proc.stdout.on('data',(chunk:string)=>{
    if(child!==proc)return;
    partial+=chunk;if(partial.length+frame.length>65536){stop();return;}
    let end:number;
    while((end=partial.indexOf('\n'))>=0){
     const line=partial.slice(0,end);partial=partial.slice(end+1);
     if(line.startsWith(',')&&line.includes('bytes_in')&&line.includes('bytes_out')){
      if(frame)try{
       const value={rows:parse(frame),ts:stamp,at};
       if(waiting){const p=waiting;waiting=undefined;clearTimeout(p.timer);p.resolve(value);}else ready=value;
      }catch{stop();return;}
      frame=line+'\n';stamp=Date.now()*1000;at=performance.now();
     }else if(frame)frame+=line+'\n';
     if(frame.length>65536){stop();return;}
    }
   });
  }
  if(ready){const value=ready;ready=undefined;return value;}
  if(waiting)throw failure();
  return new Promise<{rows:T[];ts:number;at:number}>((resolve,reject)=>{
   const timer=setTimeout(()=>{stop();},3000);waiting={resolve,reject,timer};
  });
 };
 return Object.assign(collect,{reset:stop,close:async()=>{closed=true;stop();}});
}
