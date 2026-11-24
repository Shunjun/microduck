// Local software-rendered 3D mesh. The asset and joint order are shared with robotctl.
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const rotate=(q,v)=>{const t=cross(q.slice(1),v).map(x=>2*x);return add(v,add(t.map(x=>q[0]*x),cross(q.slice(1),t)));};
const mul=(a,b)=>[a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];
const compose=(a,b)=>({p:add(a.p,rotate(a.q,b.p)),q:mul(a.q,b.q)});
export function parseMesh(buffer){
 const v=new DataView(buffer);let o=0;
 const n=(method,size)=>()=>{if(o+size>v.byteLength)throw Error('模型数据不完整');const x=v[method](o,true);o+=size;return x;};
 const u8=n('getUint8',1),u16=n('getUint16',2),i16=n('getInt16',2),u32=n('getUint32',4),f32=n('getFloat32',4),vec=()=>[f32(),f32(),f32()],quat=()=>[f32(),f32(),f32(),f32()];
 if(String.fromCharCode(u8(),u8(),u8(),u8())!=='DUCK'||u32()!==1)throw Error('模型版本不匹配');
 const nm=u16(),nb=u16(),np=u16();const meshes=Array.from({length:nm},()=>{const nv=u16(),nt=u16();return {vertices:Array.from({length:nv},vec),triangles:Array.from({length:nt},()=>[u16(),u16(),u16()])};});
 const bodies=Array.from({length:nb},()=>({parent:i16(),joint:i16(),p:vec(),q:quat(),axis:vec()}));
 const parts=Array.from({length:np},()=>{const body=u16(),mesh=u16(),rgb=[u8(),u8(),u8()];u8();return {body,mesh,rgb,p:vec(),q:quat()};});
 return {meshes,bodies,parts};
}
export class Preview {
 constructor(canvas){this.canvas=canvas;this.angles=Array(15).fill(0);this.yaw=.8;this.pitch=.3;this.zoom=1;this.model=null;this.queued=false;
  let last=null;canvas.addEventListener('pointerdown',e=>{last=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);});canvas.addEventListener('pointermove',e=>{if(!last)return;this.yaw+=(e.clientX-last[0])*.01;this.pitch=Math.max(-.3,Math.min(1.2,this.pitch+(e.clientY-last[1])*.008));last=[e.clientX,e.clientY];this.draw();});for(const name of ['pointerup','pointercancel'])canvas.addEventListener(name,()=>last=null);
  canvas.addEventListener('wheel',e=>{e.preventDefault();this.zoom=Math.max(.5,Math.min(2.5,this.zoom*Math.exp(-e.deltaY*.001)));this.draw();},{passive:false});new ResizeObserver(()=>this.draw()).observe(canvas);
 }
 async load(){const r=await fetch('/duck.bin');if(!r.ok)throw Error('模型加载失败');this.model=parseMesh(await r.arrayBuffer());this.draw();}
 pose(angles){this.angles=angles;this.draw();}
 reset(){this.yaw=.8;this.pitch=.3;this.zoom=1;this.draw();}
 draw(){if(this.queued)return;this.queued=true;requestAnimationFrame(()=>{this.queued=false;this.render();});}
 render(){const c=this.canvas,ctx=c.getContext('2d'),w=c.clientWidth,h=c.clientHeight,dpr=Math.min(devicePixelRatio||1,2);c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);if(!this.model)return;
  const scale=Math.min(w,h)*2.3*this.zoom,cy=Math.cos(this.yaw),sy=Math.sin(this.yaw),cp=Math.cos(this.pitch),sp=Math.sin(this.pitch);
  const project=p=>{const x=cy*p[0]-sy*p[1],depth=sy*p[0]+cy*p[1],z=p[2]-.13;return [w/2+x*scale,h*.53-(cp*z-sp*depth)*scale,cp*depth+sp*z];};
  ctx.strokeStyle='#bcc8b0';ctx.lineWidth=.6;for(let k=-6;k<=6;k++){for(const p of [[[k*.05,-.3,0],[k*.05,.3,0]],[[-.3,k*.05,0],[.3,k*.05,0]]]){const a=project(p[0]),b=project(p[1]);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();}}
  const poses=[];
  for(const b of this.model.bodies){let p={p:b.p,q:b.q};if(b.joint>=0){const angle=this.angles[b.joint]||0,s=Math.sin(angle/2);p=compose(p,{p:[0,0,0],q:[Math.cos(angle/2),...b.axis.map(x=>x*s)]});}poses.push(b.parent<0?p:compose(poses[b.parent],p));}
  const triangles=[];
  for(const part of this.model.parts){const mesh=this.model.meshes[part.mesh],pose=compose(poses[part.body],part),vertices=mesh.vertices.map(v=>add(pose.p,rotate(pose.q,v)));
   for(const ids of mesh.triangles){const points=ids.map(i=>vertices[i]),normal=cross(points[1].map((x,i)=>x-points[0][i]),points[2].map((x,i)=>x-points[0][i])),length=Math.hypot(...normal)||1;const light=.5+.5*Math.abs((normal[0]*.3-normal[1]*.5+normal[2]*.8)/length),screen=points.map(project);triangles.push({screen,depth:screen.reduce((s,p)=>s+p[2],0)/3,color:`rgb(${part.rgb.map(x=>Math.round(x*light)).join(',')})`});}
  }
  triangles.sort((a,b)=>b.depth-a.depth);for(const t of triangles){ctx.beginPath();ctx.moveTo(t.screen[0][0],t.screen[0][1]);ctx.lineTo(t.screen[1][0],t.screen[1][1]);ctx.lineTo(t.screen[2][0],t.screen[2][1]);ctx.closePath();ctx.fillStyle=t.color;ctx.fill();}
  ctx.fillStyle='#76856a';ctx.font='10px monospace';ctx.fillText('ALPHA / JOINT-SPACE PREVIEW',18,h-18);
 }
}
