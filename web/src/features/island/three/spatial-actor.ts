import type { components } from '../../../api/schema';
import { allowedIslandActivities } from '../island-activity-access';
import type { IslandAccess, IslandActivity } from '../island-activity-access';
import type { SpatialPoint } from '../spatial-geometry';
import { createSpatialNavigation, spatialLocalToWorld, spatialWorldToLocal } from './spatial-navigation';
import type { SpatialLayout, SpatialNavigation, SpatialPlacement, SpatialSpace } from './spatial-navigation';

export type SpatialActorActivity = 'walk' | 'rest' | IslandActivity;
export type SpatialActorUnavailable = 'locked' | 'unreachable' | 'missing_target' | 'missing_presentation';
export type SpatialActorAttachment = components['schemas']['SpatialActivityAttachment'];
export type SpatialBallTiming = components['schemas']['SpatialBallTiming'];
type ActivityPresentation = components['schemas']['SpatialActivityPresentation'];

// 触球位置来自动作绑定。营地负责球从地面出发、飞出并滚回的轨迹。
export function spatialBallPosition(elapsed:number,timing:SpatialBallTiming):[number,number,number] {
  const {period_seconds:period,contact_seconds:contact,contact_position:[x,y,z]}=timing;
  const time=((elapsed%period)+period)%period;
  const startY=0.13,startZ=0.6;
  if(time<=contact) {
    const progress=time/contact;
    return [x*progress,startY+(y-startY)*progress+Math.sin(progress*Math.PI)*0.12,startZ+(z-startZ)*progress];
  }
  const progress=(time-contact)/(period-contact);
  return [x*(1-progress),startY+(y-startY)*(1-progress)+Math.sin(progress*Math.PI)*0.45,z+(startZ-z)*progress+Math.sin(progress*Math.PI)];
}

/** UI 递增 sequence 表示一次新命令，目标坐标始终是厘米世界坐标。 */
export interface SpatialActorIntent {
  sequence:number; // 同一命令不会因 React 重渲染重新启动。
  activity:SpatialActorActivity; // 业务身份与人物动画语义分开。
  instanceId?:string; // 可选的已摆放物件目标。
  destination?:SpatialPoint; // 散步的明确世界落点。
  space?:SpatialSpace; // 无明确目标时选择室内或室外落点。
}
/** 页面只接收离散状态，不接收逐帧位置。 */
export interface SpatialActorStatus {
  phase:'idle'|'walking'|'performing'; // 规划同步完成，不暴露短暂选目标状态。
  activity:SpatialActorActivity; // 当前统一执行的活动。
  space:SpatialSpace; // 屋顶显隐依据角色所在空间。
  targetInstanceId?:string; // 当前物件目标。
}
/** 每次推进都传入新资格与校准时钟，暂停也执行零时间校验。 */
export interface SpatialActorEnvironment {
  layout:SpatialLayout; // 当前确认或退出编辑后的完整布局。
  access:IslandAccess|null; // 最新资格；加载期间受限资格已被hook撤销。
  now:()=>number; // ApiClient 校准后的当前时间。
  editing:boolean; // 编辑期间冻结人物与导航布局。
  paused:boolean; // 页面隐藏、暂停和减少动效的合并状态。
  actions?:ReadonlySet<string>; // 当前身体声明的动作，场景测试可单独提供表演数据。
}
interface ActorTarget {
  placement:SpatialPlacement; // 规划时复制的实例位置，用来发现目标移动。
  presentation:ActivityPresentation; // 规划与播放共用同一版本的目录绑定。
  approach:SpatialPoint; // 结束或撤销后返回的可行走落点。
  pose:SpatialPoint & {y_cm:number;rotation:number}; // 表演根点允许进入座面体积。
}

// 在房屋局部XZ上插值实际floor三角面；重叠面取最高处，边界共享不产生高度缝隙。
export function spatialWalkSurfaceHeight(point:SpatialPoint,surface:components['schemas']['SpatialWalkSurface']):number|null {
  let height:number|null=null;
  for(const [ia,ib,ic] of surface.triangles) {
    const a=surface.vertices[ia!]!,b=surface.vertices[ib!]!,c=surface.vertices[ic!]!;
    const denominator=(b.z_cm-c.z_cm)*(a.x_cm-c.x_cm)+(c.x_cm-b.x_cm)*(a.z_cm-c.z_cm);
    if(Math.abs(denominator)<1e-9)continue;
    const u=((b.z_cm-c.z_cm)*(point.x_cm-c.x_cm)+(c.x_cm-b.x_cm)*(point.z_cm-c.z_cm))/denominator;
    const v=((c.z_cm-a.z_cm)*(point.x_cm-c.x_cm)+(a.x_cm-c.x_cm)*(point.z_cm-c.z_cm))/denominator;
    const w=1-u-v;
    if(Math.min(u,v,w)<-1e-8)continue;
    const candidate=u*a.y_cm+v*b.y_cm+w*c.y_cm;
    height=height===null?candidate:Math.max(height,candidate);
  }
  return height;
}

/** 同一执行器处理按钮、自主活动和物件点击；位置由渲染器直接读取。 */
export class SpatialActorController {
  navigation:SpatialNavigation; // 最终布局对应的厘米导航。
  position:SpatialPoint & {y_cm:number}; // 世界位置，表演位置与导航approach分开。
  rotation=0; // Three Y 轴弧度。
  status:SpatialActorStatus; // 只在状态或空间变化时由wrapper发布。
  elapsed=0; // 当前表演时间，暂停时冻结。
  action='idle'; // 共享人物目录中的语义动作。
  ballTiming:SpatialBallTiming|undefined; // 球轨迹使用当前表演绑定中的时间与位置。
  attachments:readonly SpatialActorAttachment[]=[]; // 阅读等活动使用的骨骼道具。
  private layout:SpatialLayout; // 当前已应用布局，编辑草稿不逐帧替换它。
  private layoutSignature:string; // 接口重新返回相同布局不打断正在执行的活动。
  private route:SpatialPoint[]=[]; // 下一个路点在数组首部。
  private target:ActorTarget|null=null; // 当前活动目标及安全返回位置。
  private idleSeconds=0; // 自主活动之间保留可理解的停顿。
  private random:()=>number; // 测试可固定随机序列。

  // 出生在主屋门外，若该位置被占用则找最近可用地面。
  constructor(environment:SpatialActorEnvironment,random:()=>number=Math.random) {
    this.layout=environment.layout;this.layoutSignature=JSON.stringify([this.layout.placements,this.layout.catalog,this.layout.scene]);this.navigation=createSpatialNavigation(this.layout);this.random=random;
    const point=this.spawnPoint();
    this.position={...point,y_cm:0};this.status={phase:'idle',activity:'rest',space:this.navigation.space(point)};
    this.updateHeight();
  }

  // 请求、布局更新和逐帧推进共用当前资格复核。
  private synchronize(environment:SpatialActorEnvironment) {
    if(!environment.editing&&environment.layout!==this.layout) {
      const signature=JSON.stringify([environment.layout.placements,environment.layout.catalog,environment.layout.scene]);
      if(signature!==this.layoutSignature) {
        const changedScene=environment.layout.scene_key!==this.layout.scene_key;
        this.stop();this.layout=environment.layout;this.layoutSignature=signature;this.navigation=createSpatialNavigation(this.layout);
        this.position={...(changedScene?this.spawnPoint():this.navigation.nearest(this.position)),y_cm:0};this.updateHeight();
      } else this.layout=environment.layout;
    }
    if(this.status.phase!=='idle'&&this.status.activity!=='walk'&&this.status.activity!=='rest'&&!allowedIslandActivities(environment.access,environment.now()).includes(this.status.activity))this.stop();
    if(this.target&&!environment.editing) {
      const current=environment.layout.placements.find(item=>item.instance_id===this.target!.placement.instance_id);
      if(!current||JSON.stringify(current)!==JSON.stringify(this.target.placement)||
        (environment.actions&&!environment.actions.has(this.target.presentation.action)))this.stop();
    }
    this.updateSpace();
  }

  // 返回机器原因由页面翻译，失败时不播放对应动作。
  request(intent:SpatialActorIntent,environment:SpatialActorEnvironment):SpatialActorUnavailable|null {
    this.synchronize(environment);
    if(environment.editing)return null;
    if(intent.activity!=='walk'&&intent.activity!=='rest'&&!allowedIslandActivities(environment.access,environment.now()).includes(intent.activity))return 'locked';
    this.stop();
    if(intent.activity==='rest') {
      this.status={phase:'performing',activity:'rest',space:this.navigation.space(this.position)};this.action='rest';return null;
    }
    if(intent.activity==='walk') {
      for(let attempt=0;attempt<(intent.destination?1:8);attempt++) {
        const point=intent.destination??this.navigation.randomPoint(intent.space??this.status.space,this.random);
        if(!point)continue;
        const path=this.navigation.path(this.position,point);if(!path)continue;
        this.route=path.slice(1);this.status={phase:'walking',activity:'walk',space:this.navigation.space(this.position)};this.action='walk';return null;
      }
      return 'unreachable';
    }
    const candidates=this.layout.placements.filter(item=>(!intent.instanceId||item.instance_id===intent.instanceId)&&this.layout.catalog.find(definition=>definition.item_key===item.item_key)?.interaction?.activity===intent.activity);
    if(!candidates.length)return 'missing_target';
    const presentation=this.layout.scene.activity_presentations[intent.activity];
    const ballTiming=presentation?.ball;
    if(!presentation||(environment.actions&&!environment.actions.has(presentation.action))||(intent.activity==='ball'&&!ballTiming))return 'missing_presentation';
    candidates.sort((a,b)=>this.targetDistance(a)-this.targetDistance(b));
    for(const placement of candidates) {
      if(placement.space==='indoor'&&(!this.navigation.house||!this.layout.scene.house))continue;
      const definition=this.layout.catalog.find(item=>item.item_key===placement.item_key)!;
      const interaction=definition.interaction!;
      const house=this.navigation.house;
      const transform=placement.space==='indoor'&&house?{...spatialLocalToWorld(placement,house),rotation:placement.rotation+house.rotation}:placement;
      const approach=spatialLocalToWorld(interaction,transform),path=this.navigation.path(this.position,approach);
      if(!path)continue;
      const pose=interaction.pose??{...interaction,y_cm:0};
      const root=spatialLocalToWorld(pose,transform),rotation=transform.rotation+pose.rotation;
      // 球沿有限局部轨迹活动，整条轨迹必须留在陆地且不穿墙或家具。
      if(ballTiming&&Array.from({length:25},(_,index)=>spatialBallPosition(index*ballTiming.period_seconds/24,ballTiming)).some(point=>!this.navigation.walkable(spatialLocalToWorld({x_cm:point[0]*100,z_cm:point[2]*100},{...root,rotation}))))continue;
      this.target={placement:{...placement},presentation,approach,pose:{...root,y_cm:pose.y_cm+(placement.space==='indoor'?(this.layout.scene.house?.floor_height_cm??0):0),rotation:-rotation*Math.PI/2}};
      this.route=path.slice(1);this.status={phase:'walking',activity:intent.activity,space:this.navigation.space(this.position),targetInstanceId:placement.instance_id};this.action='walk';return null;
    }
    return 'unreachable';
  }

  // 路径走完以后才切换表演位置，不沿家具内部执行导航。
  advance(seconds:number,environment:SpatialActorEnvironment) {
    this.synchronize(environment);
    if(environment.paused||environment.editing)return;
    if(this.status.phase==='walking') {
      let distance=Math.max(0,seconds)*100;
      while(this.route.length) {
        const point=this.route[0]!,dx=point.x_cm-this.position.x_cm,dz=point.z_cm-this.position.z_cm,length=Math.hypot(dx,dz);
        if(length>0)this.rotation=Math.atan2(dx,dz);
        if(length>distance) {this.position.x_cm+=dx/length*distance;this.position.z_cm+=dz/length*distance;break;}
        this.position.x_cm=point.x_cm;this.position.z_cm=point.z_cm;this.route.shift();distance-=length;
      }
      this.updateHeight();this.updateSpace();
      if(!this.route.length) {
        if(this.target) {
          const {presentation}=this.target;
          this.position={x_cm:this.target.pose.x_cm,z_cm:this.target.pose.z_cm,y_cm:this.target.pose.y_cm};this.rotation=this.target.pose.rotation;
          this.status={...this.status,phase:'performing'};this.action=presentation.action;this.attachments=presentation.attachment?[presentation.attachment]:[];this.ballTiming=presentation.ball;this.elapsed=0;
        } else this.stop();
      }
    } else if(this.status.phase==='performing') {
      this.elapsed+=Math.max(0,seconds);if(this.elapsed>=12)this.stop();
    } else {
      this.idleSeconds+=Math.max(0,seconds);
      if(this.idleSeconds>=5) {
        this.idleSeconds=0;
        const allowed=allowedIslandActivities(environment.access,environment.now());
        const activities:SpatialActorActivity[]=['walk','walk','rest',...allowed.filter(activity=>this.layout.placements.some(item=>this.layout.catalog.find(definition=>definition.item_key===item.item_key)?.interaction?.activity===activity))];
        const activity=activities[Math.min(activities.length-1,Math.floor(this.random()*activities.length))]!;
        this.request({sequence:0,activity},environment);
      }
    }
  }

  // 停止后先回approach，下一次路径不会从座面或桌内出发。
  private stop() {
    if(this.target&&this.status.phase==='performing')this.position={...this.target.approach,y_cm:0};
    this.target=null;this.route=[];this.elapsed=0;this.idleSeconds=0;this.action='idle';this.attachments=[];this.ballTiming=undefined;
    this.status={phase:'idle',activity:'rest',space:this.navigation.space(this.position)};this.updateHeight();
  }

  // 根据目标世界位置排序，室内局部位置不能直接与世界位置相减。
  private targetDistance(placement:SpatialPlacement):number {
    const point=placement.space==='indoor'&&this.navigation.house?spatialLocalToWorld(placement,this.navigation.house):placement;
    return Math.hypot(point.x_cm-this.position.x_cm,point.z_cm-this.position.z_cm);
  }
  // 门外通路把地面连续接到室内地板；活动pose仍保留自己的表演高度。
  private updateHeight() {
    const house=this.navigation.house,geometry=this.layout.scene.house;
    if(!house||!geometry){this.position.y_cm=0;return;}
    if(this.navigation.space(this.position)==='indoor'){this.position.y_cm=geometry.floor_height_cm;return;}
    const local=spatialWorldToLocal(this.position,house),clearance=geometry.door_clearance;
    const surfaceHeight=geometry.walk_surfaces?spatialWalkSurfaceHeight(local,geometry.walk_surfaces):null;
    if(surfaceHeight!==null){this.position.y_cm=surfaceHeight;return;}
    const profile=geometry.entry_height_profile;
    const start=Math.min(clearance.min_z_cm,geometry.interior.max_z_cm,geometry.door_center.z_cm);
    const end=Math.max(clearance.max_z_cm,profile?.at(-1)?.z_cm??clearance.max_z_cm);
    const length=clearance.max_z_cm-geometry.door_center.z_cm;
    const onApproach=local.x_cm>=clearance.min_x_cm&&local.x_cm<=clearance.max_x_cm&&local.z_cm>=start&&local.z_cm<=end;
    if(onApproach&&profile?.length) {
      let lower=profile[0]!;
      for(const upper of profile) {
        if(local.z_cm<=upper.z_cm) {
          const span=upper.z_cm-lower.z_cm;
          this.position.y_cm=span>0?lower.y_cm+(upper.y_cm-lower.y_cm)*(local.z_cm-lower.z_cm)/span:upper.y_cm;
          return;
        }
        lower=upper;
      }
      this.position.y_cm=lower.y_cm;return;
    }
    this.position.y_cm=onApproach&&length>0?geometry.floor_height_cm*Math.min(1,(clearance.max_z_cm-local.z_cm)/length):0;
  }
  // 新场景使用自己的出生点；旧海边仍优先采用门外通路。
  private spawnPoint():SpatialPoint {
    const house=this.navigation.house,geometry=this.layout.scene.house;
    const point=this.layout.scene.spawn??(house&&geometry?spatialLocalToWorld({x_cm:0,z_cm:geometry.door_center.z_cm+170},house):{x_cm:0,z_cm:0});
    return this.navigation.nearest(point);
  }
  // 空间变化只产生一个新状态，不将连续位置写入React。
  private updateSpace() {const space=this.navigation.space(this.position);if(this.status.space!==space)this.status={...this.status,space};}
}
