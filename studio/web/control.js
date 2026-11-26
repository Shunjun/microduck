import {connectMedia} from './media.js';
import {Preview,bodyOrientation} from './preview.js';
import {duck,esc,notify,operation} from './ui.js';
import {preferences} from './state.js';
export function controlSource(frame,fresh){return fresh&&!frame?.move?.limited_by?.includes('deadman')?frame?.move?.source||null:null;}
export function velocityFor(x,y,speed,prefs){const length=Math.max(1,Math.hypot(x,y));return {vx:-y/length*speed/100*prefs.forward,vy:0,vyaw:-x/length*speed/100*prefs.turn};}
const actionLabels={roulade:'翻滚',kick_left:'左脚踢球',kick_right:'右脚踢球',ground_pick:'低头拾取',sit_toggle:'坐下 / 起立'};
export function quickActions(report,policies){
  if(!policies?.enabled)return [];
  return [...new Set([...(policies.skills||[]),...(report.built_in||[])])]
    .filter(name=>typeof name==='string'&&name.length>0)
    .slice(0,3).map(name=>({name,label:actionLabels[name]||name}));
}
export function setPreviewMode(root,view){
  const pose=view==='pose';
  root.querySelector('#live-pose').hidden=!pose;
  root.querySelector('#live-video').hidden=pose;
  root.querySelector('.camera-empty').hidden=pose;
  root.querySelector('.cambottom').hidden=!pose;
  root.querySelector('.subtabs .tail').textContent=pose?'实测反馈 · 非动作预测':'摄像头实时画面';
}
export function mountControl(root,robot){
  const prefs=preferences();let speed=prefs.speed,x=0,y=0,pointer=null,held=false,disposed=false,tab='pose',lastFrame=null,noticeClosed=false,mediaStatus='尚未连接摄像头',stopMedia=()=>{};
  root.innerHTML=`<div class="split control-workspace"><section class="preview-column"><div class="camera pose-view"><canvas id="live-pose" aria-label="实测三维姿态，拖动旋转，滚轮缩放"></canvas><video id="live-video" autoplay playsinline muted controls hidden aria-label="摄像头实时画面"></video><div class="camera-empty" hidden><span id="media-status">尚未连接摄像头</span><button class="secondary" id="connect-video">连接 / 重试</button><small>需要运行 mediad · 信令地址在配置中设置</small></div><div class="camtop"><span class="camtag" id="pose-status">等待实测关节数据</span><span class="camtag" id="owner">等待控制状态</span></div><div class="companion companion-float">${duck()}<div><strong>我在这里，等你一起出发。</strong><p id="companion-state">等待设备连接</p><button class="textbtn" data-route="actions">给小鸭一个动作 ↗</button></div><button class="close-companion" aria-label="关闭伙伴提示">×</button></div><div class="cambottom"><button class="camtag" id="reset-camera">重置视角</button><button class="camtag" id="fullscreen">展开画面 ↗</button></div></div><div class="subtabs"><button class="selected" data-view="pose">3D 姿态</button><button data-view="camera">摄像头画面</button><span class="tail">实测反馈 · 非动作预测</span></div></section><aside class="controlpane"><div class="ctrlintro"><h2>带小鸭走一走</h2><p class="small">拖动摇杆移动，松开回中停止</p></div><div class="joystick-wrap"><div class="joystick" tabindex="0" role="application" aria-label="移动摇杆，上下前后，左右转向"><span class="joy-direction joy-top">前</span><span class="joy-direction joy-bottom">后</span><span class="joy-direction joy-left">↶</span><span class="joy-direction joy-right">↷</span><span class="joy-knob">拖动</span></div><div class="joy-values">前进 <span id="joy-forward">0.0%</span> · 转向 <span id="joy-turn">0.0%</span></div></div><div class="speed"><div class="row"><span>本次速度上限</span><output id="speed-value" class="push">${speed.toFixed(1)}%</output></div><input class="range" id="speed" type="range" min="0" max="100" step="0.1" value="${speed}" aria-label="本次速度上限"><div class="helper">临时调节，默认值在配置中设置</div></div><div class="control-power"><button class="secondary" id="stand-up">站立就位</button><button class="secondary" id="enable-walk">启用策略</button></div><div class="divider"></div><div class="shortcuts"><div class="row"><h3>熟悉的小动作</h3><button class="textbtn push" data-route="actions">全部 →</button></div><div class="quick" id="quick-actions"><span class="helper">等待动作列表</span></div></div><div class="telemetry"><div>电量估算<strong id="battery">—</strong></div><div>连接往返<strong id="latency">—</strong></div><div>运行策略<strong id="motion">—</strong></div><div>身体状态<strong id="body">未知</strong></div></div></aside></div>`;
  const $=s=>root.querySelector(s),stick=$('.joystick'),preview=new Preview($('#live-pose'));
  preview.load().then(()=>{if(!disposed)update();}).catch(e=>notify(e.message,true));
  function send(){if(held&&robot.fresh()&&document.visibilityState==='visible')robot.notify('robot.move',velocityFor(x,y,speed,prefs));}
  function display(){const knob=$('.joy-knob');knob.style.transform=`translate(calc(-50% + ${x*stick.clientWidth*.3}px),calc(-50% + ${y*stick.clientHeight*.3}px))`;$('#joy-forward').textContent=`${(-y*speed).toFixed(1)}%`;$('#joy-turn').textContent=`${(-x*speed).toFixed(1)}%`;stick.classList.toggle('active',held);}
  function stop(){const wasHeld=held;held=false;x=y=0;pointer=null;if(wasHeld)robot.notify('robot.move',{vx:0,vy:0,vyaw:0});if(!disposed)display();}
  function point(e){const r=stick.getBoundingClientRect(),radius=r.width*.4;let a=(e.clientX-r.x-r.width/2)/radius,b=(e.clientY-r.y-r.height/2)/radius;const length=Math.hypot(a,b);if(length>1){a/=length;b/=length;}x=a;y=b;display();send();}
  stick.onpointerdown=e=>{if(e.button!==0)return;if(!robot.fresh()){notify('等待实时设备状态后才能移动',true);return;}held=true;pointer=e.pointerId;stick.setPointerCapture(pointer);point(e);};stick.onpointermove=e=>{if(held&&e.pointerId===pointer)point(e);};for(const type of ['pointerup','pointercancel','lostpointercapture'])stick.addEventListener(type,stop);
  const keys=new Set();function key(e){if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();if(e.type==='keydown'&&!robot.fresh())return;if(e.type==='keydown')keys.add(e.key);else keys.delete(e.key);x=Number(keys.has('ArrowRight'))-Number(keys.has('ArrowLeft'));y=Number(keys.has('ArrowDown'))-Number(keys.has('ArrowUp'));const length=Math.hypot(x,y);if(length>1){x/=length;y/=length;}if(keys.size){held=true;display();send();}else stop();}stick.addEventListener('keydown',key);stick.addEventListener('keyup',key);stick.addEventListener('blur',()=>{keys.clear();stop();});
  function blur(){keys.clear();stop();}window.addEventListener('blur',blur);document.addEventListener('visibilitychange',blur);window.addEventListener('studio-stop',blur);
  $('#speed').oninput=e=>{speed=Number(e.target.value);$('#speed-value').textContent=`${speed.toFixed(1)}%`;display();send();};
  $('#reset-camera').onclick=()=>{if(tab==='pose')preview.reset();};$('#fullscreen').onclick=()=>$('.camera').requestFullscreen().catch(e=>notify(e.message,true));$('.close-companion').onclick=()=>{noticeClosed=true;$('.companion-float').hidden=true;try{sessionStorage.setItem('microduck.companion.dismissed','1');}catch{}};
  try{noticeClosed=sessionStorage.getItem('microduck.companion.dismissed')==='1';}catch{}$('.companion-float').hidden=noticeClosed;
  for(const button of root.querySelectorAll('[data-view]'))button.onclick=()=>{tab=button.dataset.view;root.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b===button));setPreviewMode(root,tab);if(tab==='pose'){stopMedia();stopMedia=()=>{};mediaStatus='尚未连接摄像头';$('#media-status').textContent=mediaStatus;}update();};
  $('#connect-video').onclick=()=>{stopMedia();try{stopMedia=connectMedia($('#live-video'),message=>{if(disposed)return;mediaStatus=message;$('#media-status').textContent=message;$('.camera-empty').hidden=message==='摄像头已连接';});}catch(e){notify(e.message,true);}};
  $('#stand-up').onclick=()=>{stop();if(confirm('让鸭子上力并缓慢站立就位？请确认有支撑且周围空间足够。'))operation(async()=>{const r=await robot.request('robot.init');if(r.accepted===false)throw Error(r.reason||'站立请求被拒绝');notify('站立请求已接受，以实际姿态为准');});};
  $('#enable-walk').onclick=()=>{stop();if(confirm('启用当前配置的运动策略？之后摇杆可驱动鸭子行走。'))operation(async()=>{const r=await robot.request('robot.enable',{on:true});if(r.accepted===false)throw Error(r.reason||'启用被拒绝');notify('策略启用请求已接受');});};
  function update(){if(disposed)return;const fresh=robot.fresh(),s=robot.frame;if(!fresh)stop();const orientation=bodyOrientation(s,robot.health,fresh);$('#pose-status').textContent=tab==='camera'?mediaStatus:fresh?(orientation?'实测关节 + 身体 IMU':'实测关节 · IMU 不可用，朝向未更新'):lastFrame?'反馈过期 · 保留最后姿态':'等待反馈 · 模型初始姿态';const source=controlSource(s,fresh);$('#owner').textContent=source==='studio'?'当前由你控制':source?`控制来源：${source}`:'尚无实时控制来源';$('#owner').title='按实际运动指令来源显示，不代表其他客户端被锁定';$('#motion').textContent=fresh?s.policy:'—';$('#latency').textContent=robot.ready&&Number.isFinite(robot.latency)?`${Math.round(robot.latency)} ms`:'—';const b=robot.ready?robot.health?.battery:null;$('#battery').textContent=b?`${b.percent.toFixed(0)}%`:'—';$('#battery').title=b?`${b.volts.toFixed(2)} V，沿用 2S 电池电压估算；稳压供电不适用`:'未获得电池电压';$('#body').textContent=!fresh?'未知':(!robot.health?.imu?.ready||robot.health.imu.missing||robot.health.imu.consecutive_stale_blocks>=25)?'IMU 未就绪 / 异常':s.safety?.fallen?'已摔倒':s.safety?.picked_up?'被抱起':s.safety?.limp?'低增益保持':'未报告异常';$('#companion-state').textContent=fresh?`当前策略：${s.policy}`:'等待设备连接';if(fresh&&Array.isArray(s.joints)&&s.joints.length===15&&s.joints.every(Number.isFinite)&&s!==lastFrame){lastFrame=s;preview.pose(s.joints,orientation);}}
  robot.addEventListener('connection',update);robot.addEventListener('frame',update);robot.addEventListener('health',update);const tick=setInterval(()=>{send();update();},50);
  let quickRequest=0;
  function refreshQuick(){
    const request=++quickRequest;
    $('#quick-actions').onclick=null;
    $('#quick-actions').textContent=robot.ready?'正在读取可用动作…':'连接后可查看动作';
    if(!robot.ready)return;
    Promise.all([robot.request('robot.skills'),robot.request('robot.policies')]).then(([report,policies])=>{
      if(disposed||request!==quickRequest||!robot.ready)return;
      const actions=quickActions(report,policies);
      $('#quick-actions').innerHTML=actions.length?actions.map(({name,label})=>`<button data-skill="${esc(name)}">${esc(label)}</button>`).join(''):'<span class="helper">暂无可用动作，请先在动作库导入并注册模型</span>';
      $('#quick-actions').onclick=e=>{const b=e.target.closest('[data-skill]');if(b){stop();const action=actions.find(a=>a.name===b.dataset.skill);if(!action)return;if(confirm(`执行动作「${action.label}」？`))operation(async()=>{const r=await robot.request('robot.do',{skill:action.name});if(r.accepted===false)throw Error(r.reason||'动作未接受');notify('动作请求已接受');});}};
    }).catch(()=>{if(!disposed&&request===quickRequest)$('#quick-actions').textContent='无法读取可用动作';});
  }
  robot.addEventListener('connection',refreshQuick);refreshQuick();
  update();return ()=>{stop();disposed=true;stopMedia();clearInterval(tick);preview.dispose();window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',blur);window.removeEventListener('studio-stop',blur);robot.removeEventListener('connection',refreshQuick);for(const name of ['connection','frame','health'])robot.removeEventListener(name,update);};
}
