import {strict as assert} from 'node:assert';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(`${tmpdir()}/studio-web-test-`);
try{
  for(const name of ['control','state','ui','preview','media'])await writeFile(`${dir}/${name}.js`,await readFile(new URL(`../web/${name}.js`,import.meta.url)));
  await writeFile(`${dir}/package.json`,'{"type":"module"}');
  const {velocityFor,controlSource}=await import(pathToFileURL(`${dir}/control.js`));
  const {preferences}=await import(pathToFileURL(`${dir}/state.js`));
  assert.equal(controlSource({move:{source:'studio',limited_by:['deadman']}},true),null);
  assert.equal(controlSource({move:{source:'studio',limited_by:[]}},true),'studio');
  assert.equal(controlSource({move:{source:'padd'}},false),null);
  const prefs={forward:.2,turn:1};
  assert.deepEqual(velocityFor(0,-1,50,prefs),{vx:.1,vy:0,vyaw:-0});
  assert.equal(velocityFor(0,-.5,50,prefs).vx,.05);
  assert.equal(velocityFor(0,-1,0,prefs).vx,0);
  assert.equal(velocityFor(1,0,100,prefs).vyaw,-1);
  const diagonal=velocityFor(1,-1,100,prefs);assert.ok(diagonal.vx<.2&&diagonal.vyaw> -1);
  globalThis.localStorage={getItem:()=>'{"speed":0,"forward":999,"turn":999}'};
  assert.deepEqual(preferences(),{speed:0,forward:.5,turn:2});
  globalThis.localStorage={getItem:()=>'{bad'};assert.equal(preferences().speed,35);
  console.log('PASS: linear joystick, diagonal/zero caps, preference bounds, stale control ownership');
}finally{await rm(dir,{recursive:true,force:true});}
