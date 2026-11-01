import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient, ApiFailure, errorMessage } from '../../api/client';
import type { Session } from '../../api/types';
import { AppearanceProvider } from '../character/AppearanceProvider';
import { IslandPage3D } from './IslandPage3D';
import content from './three/spatial-content.json';
import '../../styles/island.css';

// 独立验收入口只恢复真实会话，登录和正式导航仍由主应用负责。
function Island3DVerification(){
  const [session,setSession]=useState<Session|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<unknown>(null),[attempt,setAttempt]=useState(0);
  const [client]=useState(()=>new ApiClient(status=>{if(status===401)setSession(null);}));
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError(null);
    void client.request<Session>('/session',{signal:controller.signal}).then(next=>{if(controller.signal.aborted)return;client.setCsrfToken(next.csrf_token);client.recordServerTime(next.server_now);setSession(next);}).catch(reason=>{if(!controller.signal.aborted&&!(reason instanceof ApiFailure&&reason.status===401))setError(reason);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[client,attempt]);
  if(loading)return <main className="app"><p role="status">{content.sessionLoading}</p></main>;
  if(!session)return <main className="app"><h1>{content.title}</h1>{error!==null&&<><p role="alert">{errorMessage(error)}</p><button onClick={()=>setAttempt(value=>value+1)}>{content.retry}</button></>}<a href="/">{content.login}</a></main>;
  const back=()=>{window.location.assign('/');};
  return <AppearanceProvider key={session.csrf_token} client={client} active><IslandPage3D client={client} session={session} onBack={back} onShop={back} onCamp={back}/></AppearanceProvider>;
}
document.title=content.title;
createRoot(document.getElementById('root')!).render(<StrictMode><Island3DVerification/></StrictMode>);
