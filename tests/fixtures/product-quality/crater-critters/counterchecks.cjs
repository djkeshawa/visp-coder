// Execute the preserved implementation in a minimal DOM. These are behavior probes, not source-string assertions.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const elements = new Map();
const context = vm.createContext({
  document: { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {dataset:{},classList:{toggle(){}},setAttribute(){},addEventListener(){},getContext(){return {};}});
    return elements.get(selector);
  } },
  window: {}, performance: {now:()=>0}, requestAnimationFrame() {},
});
vm.runInContext(script, context);
const results = vm.runInContext(`(() => {
  const target = game.critters[0];
  const nearMiss = {x:target.x,y:target.y+128,r:22,vx:1};
  const missScores = projectileHitsCritter(nearMiss, {x:target.x-10,y:nearMiss.y}, target);
  const contactScores = projectileHitsCritter({x:target.x,y:target.y,r:22,vx:1}, {x:target.x-1,y:target.y}, target);
  const block = game.blocks[0];
  game.soundEnabled = false;
  game.projectile = {x:block.x+30,y:block.y+10,vx:1,vy:0,r:22,angle:0,settle:0,impactFlash:0,trail:[]};
  updateProjectile(0);
  return [
    {check:'clear miss must not score',defect:missScores,centerDistance:128,combinedRadii:47},
    {check:'actual contact must score',passed:contactScores},
    {check:'overlapping block must receive damage',defect:block.health===block.maxHealth},
  ];
})()`, context);
console.log(JSON.stringify(results));
