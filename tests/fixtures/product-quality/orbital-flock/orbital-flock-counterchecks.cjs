const fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'index.html'),'utf8');
const script=html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>'));
function load(){
 const elements=new Map(),timers=[];
 function element(id){if(!elements.has(id))elements.set(id,{hidden:true,disabled:false,textContent:'',handlers:{},addEventListener(k,fn){this.handlers[k]=fn},appendChild(){},setAttribute(){},getContext(){return {}},getBoundingClientRect(){return {left:0,top:0,width:1200,height:680}},setPointerCapture(){},releasePointerCapture(){}});return elements.get(id)}
 const scope={document:{querySelector:element,createElement:()=>element(Symbol())},window:{matchMedia:()=>({matches:false}),setTimeout(fn){timers.push(fn)},addEventListener(){}},requestAnimationFrame(){},Math};
 const at=script.lastIndexOf('    })();');
 vm.runInNewContext(script.slice(0,at)+'globalThis.audit={state,SLING,circleRectCollision,hitBlock,resetLevel,quickShot,update,finishTurn,launchBird};\n'+script.slice(at),scope,{timeout:1000});
 return {...scope.audit,elements,timers};
}
const a=load(),n=Math.SQRT1_2;
a.state.bird={x:0,y:0,vx:100,vy:0,r:23};a.hitBlock({cooldown:0,hp:2},{nx:n,ny:n,overlap:1});
const report={cornerReflection:{incoming:{vx:100,vy:0},normal:{x:n,y:n},observed:{vx:a.state.bird.vx,vy:a.state.bird.vy},expectedWithExistingDamping:{vx:0,vy:-48}}};
const b=load();b.state.turn='flying';b.state.targets.forEach(t=>t.alive=false);b.finishTurn();b.resetLevel({keepScore:false});b.timers.forEach(fn=>fn());
report.resetRace={turn:b.state.turn,overlayVisible:!b.elements.get('#gameOverlay').hidden,title:b.elements.get('#overlayTitle').textContent,targetsAlive:b.state.targets.filter(t=>t.alive).length};
const c=load();c.state.level=2;c.resetLevel();c.state.turn='won';c.elements.get('#primaryAction').handlers.click();report.playAgain={levelIndex:c.state.level,turn:c.state.turn};
report.topContacts=[770,829.5].map(x=>({x,collision:a.circleRectCollision({x,y:380,r:23},{x:744,y:391,w:171,h:20})}));
report.quickShotLevels=[];
for(const dt of [1/120,1/60,0.032]) for(let level=0;level<3;level++){
 const g=load();g.state.level=level;g.resetLevel({keepScore:false});let shots=0;
 while(g.state.turn==='ready'&&shots<4){g.quickShot();shots++;for(let i=0;i<2000&&g.state.turn==='flying';i++)g.update(dt)}
 report.quickShotLevels.push({dt,level:level+1,shots,turn:g.state.turn,remaining:g.state.targets.filter(t=>t.alive).length,score:g.state.score});
}
console.log(JSON.stringify(report,null,2));
