import {strict as assert} from 'node:assert';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../frontend/src/lib/media.js',import.meta.url),'utf8');
const {connectMedia}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
class Socket {
  static OPEN=1;
  constructor(){this.readyState=1;this.messages=[];Socket.last=this;}
  send(data){this.messages.push(JSON.parse(data));}
  close(){this.readyState=3;this.onclose?.();}
}
class Peer {
  constructor(){Peer.last=this;this.candidates=[];}
  async setRemoteDescription(value){this.remoteDescription=value;}
  async createAnswer(){return {type:'answer',sdp:'answer-sdp'};}
  async setLocalDescription(value){this.localDescription=value;}
  async addIceCandidate(value){this.candidates.push(value);}
  close(){this.closed=true;}
}
globalThis.WebSocket=Socket;globalThis.RTCPeerConnection=Peer;
const states=[],video={srcObject:null};const stop=connectMedia(video,text=>states.push(text),'ws://duck:8443');
const ws=Socket.last;
async function message(value){ws.onmessage({data:JSON.stringify(value)});await new Promise(resolve=>setImmediate(resolve));}
await message({type:'welcome'});assert.deepEqual(ws.messages[0],{type:'list'});
await message({type:'list',producers:[{id:'camera'}]});
assert.deepEqual(ws.messages[1],{type:'startSession',peerId:'camera'});
await message({type:'list',producers:[{id:'camera'}]});assert.equal(ws.messages.length,2);
await message({type:'sessionStarted',sessionId:'s1'});
await message({type:'peer',sessionId:'s1',ice:{candidate:'ice',sdpMLineIndex:0}});
assert.equal(Peer.last.candidates.length,0);
await message({type:'peer',sessionId:'s1',sdp:{type:'offer',sdp:'offer-sdp'}});
assert.equal(Peer.last.candidates.length,1);
assert.deepEqual(ws.messages.at(-1),{type:'peer',sessionId:'s1',sdp:{type:'answer',sdp:'answer-sdp'}});
stop();assert.equal(Peer.last.closed,true);assert.equal(ws.readyState,3);
assert.deepEqual(ws.messages.at(-1),{type:'endSession',sessionId:'s1'});
assert.throws(()=>connectMedia(video,()=>{},'http://duck:8443'),/ws/);
console.log('PASS: mediad signalling, duplicate listing, queued ICE, answer envelope and teardown');
