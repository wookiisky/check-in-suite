import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import content from './spatial-content.json';

/** WebGL初始化或渲染失败也保留HTML操作与重试入口。 */
export class SpatialSceneBoundary extends Component<{children:ReactNode;onError:(error:unknown)=>void},{failed:boolean}>{
  override state={failed:false}; // 只有本次Canvas实例的错误状态。
  // 重试通过外层key创建新实例，不复用已失败的WebGL上下文。
  static getDerivedStateFromError(){return {failed:true};}
  override componentDidCatch(error:Error,_info:ErrorInfo){this.props.onError(error);}
  override render(){return this.state.failed?<p className="spatial-webgl-error" role="alert">{content.sceneError}</p>:this.props.children;}
}
