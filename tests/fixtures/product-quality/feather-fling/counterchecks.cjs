const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
function boot() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { width:1280, height:720, hidden:false, style:{}, textContent:'', listeners:{}, classList:{toggle(){}}, addEventListener(k,f){this.listeners[k]=f}, getContext(){return {}}, setAttribute(){}, focus(){}, setPointerCapture(){}, releasePointerCapture(){}, hasPointerCapture(){return true}, getBoundingClientRect(){return {left:0,top:0,width:1280,height:720}} });
    return elements.get(id);
  };
  const sandbox = {document:{getElementById:element}, window:{matchMedia:()=>({matches:true}),localStorage:{getItem:()=>null,setItem(){}},setTimeout(){}},performance:{now:()=>0},requestAnimationFrame(){},console};
  const code = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)[1].replace(/\}\)\(\);\s*$/, 'globalThis.api={state,ui,loadLevel,updateAim,launchBird,triggerFail,nextLevel,collideBirdWithWorld,updateGame,hitBlock,beginAim,moveAim,endAim,handleKey,resetLevel};})();');
  vm.runInNewContext(code,sandbox,{timeout:1000});
  return {a:sandbox.api,e:element};
}
const results=[];
function record(name,expected,actual,defect){results.push({name,expected,actual,defect});assert.ok(defect,name+' no longer reproduced');}
{
 const {a}=boot();a.updateAim({x:100,y:574});a.launchBird();
 record('Down-left pull launches down-right','vx > 0 and vy < 0',{vx:a.state.activeBird.vx,vy:a.state.activeBird.vy},a.state.activeBird.vx>0&&a.state.activeBird.vy>0);
}
{
 const {a}=boot();a.state.bodies=[{id:'isolated',x:500,y:300,w:100,h:100,broken:false,hitCooldown:1}];a.state.targets=[];
 const b={x:435,y:300,r:20,vx:10,vy:0};a.collideBirdWithWorld(b);
 record('Incoming left-face collision accelerates into block','reflected vx < 0',b,b.vx>10);
}
{
 const {a}=boot();a.triggerFail();const label=a.ui.nextButton.textContent;const before=a.state.levelIndex;a.nextLevel();
 record('Try again advances the failed level','same level',{label,before,after:a.state.levelIndex},a.state.levelIndex!==before);
}
{
 const {a,e}=boot();const event={pointerId:1,clientX:100,clientY:574,preventDefault(){}};
 a.beginAim(event);const before=a.state.birdsLeft;e('game-canvas').listeners.pointercancel(event);
 record('Pointer cancellation fires the bird','no shot and no bird consumed',{before,after:a.state.birdsLeft,mode:a.state.mode},a.state.birdsLeft===before-1&&a.state.mode==='flying');
}
{
 const {a}=boot();const roof=a.state.bodies[2],before=roof.y;
 a.hitBlock(a.state.bodies[0],100,812,527);a.hitBlock(a.state.bodies[1],100,1070,527);
 for(let i=0;i<120;i++)a.updateGame(1/60);
 record('Unsupported roof stays suspended','roof falls after both supports break',{supportsBroken:[a.state.bodies[0].broken,a.state.bodies[1].broken],roofBefore:before,roofAfter:roof.y,wake:roof.wake},roof.y===before&&!roof.wake);
}
{
 const {a}=boot();const event={key:' ',preventDefault(){}};a.handleKey(event);const v1=a.state.activeBird.vx;a.resetLevel();a.handleKey(event);const v2=a.state.activeBird.vx;
 assert.ok(v1>0&&v2===v1);results.push({name:'Reset restores launchable keyboard state',passed:true,v1,v2});
}
console.log(JSON.stringify(results,null,2));
