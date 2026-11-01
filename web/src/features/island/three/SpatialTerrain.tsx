import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { DoubleSide, Shape } from 'three';
import type { MeshStandardMaterial } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { SpatialIslandState } from './spatial-ui-types';

type TerrainShader=Parameters<MeshStandardMaterial['onBeforeCompile']>[0];

// 纹理只改变颜色，不移动岸线顶点，也不参与摆放或导航。
function terrainPattern(shader:TerrainShader,terrain:string,time:{value:number}){
  shader.uniforms.campTime=time;
  shader.vertexShader=`varying vec2 campPosition;\n${shader.vertexShader}`.replace('#include <begin_vertex>','#include <begin_vertex>\ncampPosition=position.xy;');
  shader.fragmentShader=`varying vec2 campPosition;\nuniform float campTime;\n${shader.fragmentShader}`;
  const pattern=terrain==='grass'
    ? 'float grassVariation=sin(campPosition.x*0.65+sin(campPosition.y*0.4))*sin(campPosition.y*0.75);diffuseColor.rgb*=0.98+grassVariation*0.055;'
    : 'float wave=pow(max(0.0,sin(campPosition.y*2.4+sin(campPosition.x*0.45)*0.6+campTime*0.5)),18.0);diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.82,0.96,0.94),wave*0.17);';
  shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>\n${pattern}`);
}

// 岸线只读取场景多边形；远海只是背景，不扩大可放置地面。
export function SpatialTerrain({state,paused,onPointerDown}:{state:SpatialIslandState;paused:boolean;onPointerDown:(event:ThreeEvent<PointerEvent>)=>void}){
  const time=useMemo(()=>({value:0}),[]),wasPaused=useRef(true);
  useFrame((_,seconds)=>{if(!paused&&!wasPaused.current)time.value+=Math.min(seconds,.1);wasPaused.current=paused;});
  const regions=useMemo(()=>state.scene.regions.map(region=>{
    const shape=new Shape();region.polygon.forEach((point,index)=>{if(index===0)shape.moveTo(point.x_cm/100,-point.z_cm/100);else shape.lineTo(point.x_cm/100,-point.z_cm/100);});shape.closePath();
    return {...region,shape};
  }),[state.scene.regions]);
  const dusk=state.environment_key==='dusk';
  return <group name="spatial-terrain">
    {state.scene.background_terrain==='water'&&<mesh rotation={[-Math.PI/2,0,0]} position={[0,-.16,0]} onPointerDown={onPointerDown} receiveShadow><planeGeometry args={[180,180]}/><meshStandardMaterial color={dusk?'#6995a8':'#72cbd9'} roughness={.85} onBeforeCompile={shader=>terrainPattern(shader,'water',time)} customProgramCacheKey={()=>'camp-water-v1'}/></mesh>}
    {regions.map((region,index)=><mesh key={index} rotation={[-Math.PI/2,0,0]} position={[0,region.terrain==='water'?-.06:-.65,0]} onPointerDown={onPointerDown} receiveShadow>
      {region.terrain==='water'?<shapeGeometry args={[region.shape]}/>:<extrudeGeometry args={[region.shape,{depth:.65,bevelEnabled:false}]}/>}
      <meshStandardMaterial side={DoubleSide} color={region.terrain==='grass'?(dusk?'#81a975':'#9ccf83'):region.terrain==='sand'?'#f0d7a5':(dusk?'#76aabd':'#8dd9df')} roughness={1} flatShading onBeforeCompile={shader=>{if(region.terrain!=='sand')terrainPattern(shader,region.terrain,time);}} customProgramCacheKey={()=>`camp-${region.terrain}-v1`}/>
    </mesh>)}
  </group>;
}
