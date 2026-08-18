import React from 'react';
import {AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {FPS} from './root';

const f=(seconds:number)=>Math.round(seconds*FPS);
const scene=(start:number,duration:number)=>({from:f(start),durationInFrames:f(duration)});

const Footage:React.FC<{start:number;zoom?:number;focusX?:number;dim?:number}> = ({start,zoom=1,focusX=50,dim=0}) => (
  <AbsoluteFill style={{background:'#050a11',overflow:'hidden'}}>
    <OffthreadVideo muted src={staticFile('source/worldline-demo-1080.mp4')} trimBefore={f(start)} style={{position:'absolute',width:'100%',height:'100%',objectFit:'contain',transform:`scale(${zoom})`,transformOrigin:`${focusX}% 50%`}} />
    {dim>0&&<AbsoluteFill style={{background:`rgba(3,8,14,${dim})`}}/>}
  </AbsoluteFill>
);

const Tag:React.FC<{children:React.ReactNode;accent?:string;side?:'left'|'right'}>=({children,accent='#69d6ff',side='left'})=>{
  const frame=useCurrentFrame(); const x=interpolate(frame,[0,12],[side==='left'?-35:35,0],{extrapolateRight:'clamp'}); const opacity=interpolate(frame,[0,9],[0,1],{extrapolateRight:'clamp'});
  return <div style={{position:'absolute',top:58,[side]:66,transform:`translateX(${x}px)`,opacity,background:'#07101de8',border:`1px solid ${accent}66`,borderLeft:`4px solid ${accent}`,borderRadius:8,padding:'14px 18px',color:'#f1f7ff',font:'600 20px ui-monospace,monospace',letterSpacing:'.08em',boxShadow:'0 12px 35px #0009'}}>{children}</div>;
};

const Intro=()=>{const frame=useCurrentFrame();const opacity=interpolate(frame,[0,12,270,294],[0,1,1,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});return <AbsoluteFill><Footage start={28} zoom={1.12} focusX={61} dim={.44}/><AbsoluteFill style={{background:'linear-gradient(90deg,rgba(5,10,17,.96) 0%,rgba(5,10,17,.58) 52%,rgba(5,10,17,.16) 100%)'}}/><div style={{position:'absolute',left:115,top:270,opacity,width:900}}><Img src={staticFile('brand/worldline-lockup.svg')} style={{width:610,height:'auto'}}/><div style={{marginTop:42,color:'#77d9ff',font:'600 21px ui-monospace,monospace',letterSpacing:'.18em'}}>SHARED EPISODIC MEMORY FOR AUTONOMOUS MACHINES</div><div style={{marginTop:22,font:'500 38px/1.3 Inter,Arial',color:'#e9f1fa'}}>Two agents. One physical world.<br/>Only safe futures may commit.</div></div></AbsoluteFill>};

const EndCard=()=>{const frame=useCurrentFrame();const p=interpolate(frame,[0,24],[0,1],{extrapolateRight:'clamp'});return <AbsoluteFill style={{background:'radial-gradient(circle at 50% 45%,#102033,#050a11 64%)',alignItems:'center',justifyContent:'center'}}><div style={{opacity:p,transform:`translateY(${(1-p)*24}px)`,textAlign:'center'}}><Img src={staticFile('brand/worldline-lockup.svg')} style={{width:720}}/><div style={{marginTop:50,color:'#8da4ba',font:'500 23px ui-monospace,monospace',letterSpacing:'.12em'}}>COCKROACHDB × AWS AGENTIC MEMORY HACKATHON</div><div style={{marginTop:62,font:'600 42px Inter,Arial',color:'#f0f6fc'}}>Agents don't just predict the future. <span style={{color:'#57d68a'}}>They negotiate it.</span></div></div></AbsoluteFill>};

export const WorldlineDemo:React.FC=()=> <AbsoluteFill style={{background:'#050a11',fontFamily:'Inter,Arial,sans-serif'}}>
  <Sequence {...scene(0,10)}><Intro/><Audio src={staticFile('audio/01-intro.wav')}/></Sequence>
  <Sequence {...scene(10,11)}><Footage start={0}/><Tag>SPACE–TIME RESERVATION</Tag><Audio src={staticFile('audio/02-problem.wav')}/></Sequence>
  <Sequence {...scene(21,28)}><Footage start={11} zoom={1.055} focusX={58}/><Tag accent="#ff775f">CONFLICT → SERIALIZABLE COMMIT</Tag><Sequence from={f(10)}><Tag accent="#56d68b" side="right">VECTOR MEMORY → SAFE MANEUVER</Tag></Sequence><Audio src={staticFile('audio/03-hero.wav')}/><Sequence from={f(20)}><Audio src={staticFile('audio/confirm.wav')} volume={.55}/></Sequence></Sequence>
  <Sequence {...scene(49,16)}><Footage start={54} zoom={1.08} focusX={70}/><Tag accent="#56d68b" side="right">MVCC COMMIT RECEIPT</Tag><Audio src={staticFile('audio/04-receipt.wav')}/></Sequence>
  <Sequence {...scene(65,20)}><OffthreadVideo muted playbackRate={.75} src={staticFile('hyperframes.mp4')} style={{width:'100%',height:'100%',objectFit:'cover'}}/><Audio src={staticFile('audio/05-architecture-fast.wav')}/></Sequence>
  <Sequence {...scene(85,22)}><Footage start={97}/><Tag accent="#cabdff">DATABASE EVIDENCE — LIVE CLUSTER</Tag><Audio src={staticFile('audio/06-sql.wav')}/></Sequence>
  <Sequence {...scene(107,15)}><Footage start={119} zoom={1.06} focusX={70}/><Tag accent="#56d68b" side="right">AS OF SYSTEM TIME</Tag><Audio src={staticFile('audio/07-history.wav')}/></Sequence>
  <Sequence {...scene(122,15)}><EndCard/><Audio src={staticFile('audio/08-close.wav')}/></Sequence>
  <Audio src={staticFile('audio/ambient.wav')} volume={.28}/>
</AbsoluteFill>;
