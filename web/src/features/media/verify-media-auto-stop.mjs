import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
// 手动真实浏览器边界验证：从仓库根目录运行本脚本，约耗时一分钟。
// 使用独立临时账户及假麦克风，不访问真实设备；证据保存在.local/media-proof。
const label = 'chromium-auto-stop';
const directory = await mkdtemp(join(tmpdir(), 'island-recording-'));
const configPath = join(directory, 'app.yaml');
const binary = join(directory, 'island');
let api, vite, browser;
try {
 const config = { listen_address:'127.0.0.1:18084', database_path:join(directory,'island.db'), media_directory:join(directory,'media'), temp_directory:join(directory,'tmp'), assets_directory:join(directory,'assets'), sqlite_busy_timeout:'5s', http_timeout:'10s', ffprobe_path:'ffprobe', media_probe_timeout:'3s' };
 await writeFile(configPath, Object.entries(config).map(([key,value]) => `${key}: ${JSON.stringify(value)}`).join('\n')+'\n');
 execFileSync('go',['build','-o',binary,'./cmd/island'],{stdio:'inherit'});
 execFileSync(binary,['migrate','-config',configPath],{stdio:'inherit'});
 execFileSync(binary,['init','-config',configPath],{input:['recording-test','录音测试','Recording-Test-2026','Recording-Test-2026','Management-Test-2026','Management-Test-2026',''].join('\n'),stdio:['pipe','pipe','inherit']});
 api=spawn(binary,['serve','-config',configPath],{stdio:['ignore','ignore','inherit']});
 vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','web','--config','web/vite.config.ts','--host','127.0.0.1','--port','15174','--strictPort'],{env:{...process.env,ISLAND_API_TARGET:'http://127.0.0.1:18084'},stdio:['ignore','ignore','inherit']});
 for(let i=0;i<50;i++){try{const r=await fetch('http://127.0.0.1:15174/');if(r.ok)break;}catch{} await new Promise(resolve=>setTimeout(resolve,200));}
 browser=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const context=await browser.newContext({permissions:['microphone']});
 const page=await context.newPage();
 await page.goto('http://127.0.0.1:15174');
 console.log('开始真实浏览器自动停止采集，配置上限60秒');
 const result=await page.evaluate(async()=>{
  const login=await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'recording-test',password:'Recording-Test-2026'})});
  if(!login.ok)throw new Error(`login ${login.status}`);
  const session=await login.json();
  const {AudioCapture}=await import('/src/features/media/audio-capture.ts');
  return new Promise((resolve,reject)=>{
   const started=performance.now(),states=[];
   const capture=new AudioCapture({onState:(state)=>states.push(state),onTime:()=>{},onError:(error)=>{capture.dispose();reject(new Error(error));},onFile:async(file)=>{
    const elapsed=performance.now()-started;
    capture.dispose();
    const body=new FormData();body.append('kind','audio');body.append('file',file);
    const response=await fetch('/api/v1/media',{method:'POST',headers:{'X-CSRF-Token':session.csrf_token},body});
    const upload=await response.json();
    resolve({type:file.type,size:file.size,elapsed_ms:elapsed,states,upload_status:response.status,upload,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))});
   }},{audio_bytes_max:10485760,audio_seconds_max:60});
   capture.start();
  });
 });
 await mkdir('.local/media-proof',{recursive:true});
 await writeFile(`.local/media-proof/${label}.webm`,Buffer.from(result.bytes));
 const {bytes,...summary}=result;
 const frames=JSON.parse(execFileSync('ffprobe',['-v','error','-show_frames','-show_entries','frame=nb_samples,sample_rate','-of','json',`.local/media-proof/${label}.webm`],{encoding:'utf8',maxBuffer:8<<20}));
 summary.decoded_ms=frames.frames.reduce((sum,frame)=>sum+Number(frame.nb_samples||0)/Number(frame.sample_rate||48000)*1000,0);
 await writeFile(`.local/media-proof/${label}.json`,JSON.stringify(summary,null,2));
 console.log(JSON.stringify(summary));
 assert.equal(summary.upload_status, 201, 'automatic-stop recording must pass the actual upload endpoint');
 assert.ok(summary.decoded_ms > 59000 && summary.decoded_ms <= 60000, 'decoded recording must stay inside the 60-second limit');
 assert.equal(summary.upload.duration_ms, Math.ceil(summary.decoded_ms));
 assert.deepEqual(summary.states, ['requesting', 'recording', 'stopping', 'idle']);
}finally{
 await browser?.close();
 for(const child of [vite,api])if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
 await rm(directory,{recursive:true,force:true});
}
