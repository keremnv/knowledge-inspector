/** Integrated canonical canvas, actual Source controller + real adapters; no route mocks. */
import { test, expect, type Page } from '@playwright/test';
import { serveSource } from './source-serve';
import { forgetSourceCanvas, openSourceReferences } from './canvas-parity';
import { prepared, UPSTREAM } from './chinook-serve';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const table=(p:Page)=>p.locator('#source-tables .source-table-slot > .motion-swap > .motion-swap__is');
const reader=(p:Page)=>p.locator('#source-reader > .motion-swap > .motion-swap__is');
const list=(p:Page)=>p.locator('.source-field-list');
async function state(p:Page){return p.evaluate(()=>{
 const g=(window as any).__sourceFieldGraph;
 return g?{zoom:g.getZoom(),nodes:g.getNodeData().map((n:any)=>({id:n.id,at:g.getElementPosition(n.id),style:n.style})),edges:g.getEdgeData().map((e:any)=>({id:e.id,source:e.source,target:e.target,type:e.type,style:e.style,path:g.context.element.getElement(e.id)?.getShape('key')?.attributes?.d}))}:{nodes:[],edges:[],zoom:1};
});}
async function rest(p:Page,nodes:number){
 await expect.poll(async()=>{const s=await state(p);return s.nodes.length===nodes&&s.nodes.every((n:any)=>n.style.size===90&&n.style.opacity===1&&n.at.every(Number.isFinite));}).toBe(true);
 await expect(p.locator('.motion-swap__was')).toHaveCount(0);
 await p.evaluate(()=>new Promise<void>((resolve,reject)=>{
  const start=performance.now();let last='',steady=0;
  const tick=()=>{const g=(window as any).__sourceFieldGraph;const next=JSON.stringify([g?.getZoom(),g?.getCanvas().getCamera().getPosition(),[...document.querySelectorAll('.ov__body,.ants__mark')].map(e=>{const b=e.getBoundingClientRect();return[b.x,b.y,b.width,b.height]})]);steady=next===last?steady+1:0;last=next;if(steady>=12)return resolve();if(performance.now()-start>8000)return reject(Error('field did not settle'));requestAnimationFrame(tick);};requestAnimationFrame(tick);
 }));
}
async function track(p:Page,origin:string,query:string){await p.goto(`${origin}/source${query}`);await table(p).getByRole('button',{name:'Track table',exact:true}).click();await table(p).getByRole('searchbox').fill('Evil Walks');await table(p).getByRole('searchbox').press('Enter');await table(p).getByRole('button',{name:'Inspect row 1',exact:true}).click();await reader(p).locator('[data-placement="show"]').click();await rest(p,1);}
async function reference(p:Page,parent:string){await openSourceReferences(p); await reader(p).locator('.source-outgoing article').filter({hasText:`→ ${parent}`}).getByRole('button',{name:/inspect FK/}).click();await reader(p).locator('[data-reference-show]').click();}
async function point(p:Page,id:string,label=false){return p.evaluate(({id,label})=>{const g=(window as any).__sourceFieldGraph;let at=g.getElementPosition(id);if(label){const b=g.context.element.getElement(id).getShape('label').getBounds();at=[(b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2];}const v=g.getViewportByCanvas(at),b=document.querySelector('.source-canvas .world__surface')!.getBoundingClientRect();return{x:v[0]+b.left,y:v[1]+b.top};},{id,label});}

for(const motion of ['reduce','no-preference'] as const)for(const width of [1440,900]){
 test(`canonical Source lifecycle, picking and fan at ${width}, ${motion}`,async({browser})=>{
  test.skip(!prepared(),'Prepare pinned Chinook');
  await serveSource(UPSTREAM,async({origin})=>{
   const p=await browser.newPage({viewport:{width,height:1000},colorScheme:'dark',reducedMotion:motion}),errors:string[]=[];p.on('pageerror',e=>errors.push(e.message));
   try{
    // Named by Name, chosen in the table's header (O17); the demo URL policy is retired.
    await p.goto(`${origin}/source`);await table(p).getByRole('button',{name:'Album table',exact:true}).click();await table(p).getByRole('combobox',{name:'name Album records by'}).selectOption('Title');
    await track(p,origin,'?direction=selected');await table(p).getByRole('combobox',{name:'name Track records by'}).selectOption('Name');
    await expect(p.locator('.source-layer:not(.source-schema) [data-canvas-treatment]')).toHaveAttribute('data-canvas-treatment','canonical');
    const first=(await state(p)).nodes[0];expect(first.style.labelText).toBe('Evil Walks');expect(first.style.lineWidth).toBe(0);expect(first.style.labelTextBaseline).toBe('middle');expect(first.style.labelOffsetY).not.toBe(51);
    await reference(p,'Album');await rest(p,2);let s=await state(p);
    expect(s.nodes.find((n:any)=>n.id===first.id).at).toEqual(first.at);
    expect(s.nodes.map((n:any)=>n.style.labelText)).toContain('For Those About To Rock We Salute You');
    expect(s.edges).toHaveLength(2);expect(s.edges.every((e:any)=>e.type==='world-filament')).toBe(true);
    expect(s.edges.find((e:any)=>e.style.lineWidth===1)?.style.lineDash).toBeUndefined();
    const observation=s.edges.find((e:any)=>!e.id.startsWith('source-carrier:')&&!e.id.startsWith('source-summary:'))!;
    expect(observation.style.labelText).toBe('AlbumId → Album.AlbumId');
    for(const parent of ['Genre','MediaType']){await reader(p).getByRole('button',{name:'Back',exact:true}).click();await reference(p,parent);}
    await rest(p,4);
    await list(p).getByRole('button',{name:'Evil Walks',exact:true}).press("Enter");await rest(p,4);
    expect((await state(p)).edges.filter((e:any)=>!e.id.startsWith('source-carrier:')&&!e.id.startsWith('source-summary:')).every((e:any)=>e.style.labelOpacity===1)).toBe(true);
    // The actual plate, not an invented target or a click on its carrier.
    let at=await point(p,observation.id,true);await p.mouse.click(at.x,at.y);await expect(reader(p).locator('h2')).toContainText('reference');await expect(reader(p).locator('[data-reference-status]')).toHaveText('resolved');
    await expect(list(p).locator(`[data-field-reference="${observation.id}"]`)).toHaveAttribute('aria-pressed','true');
    // An endpoint stands independently of its observation's display.
    await reader(p).getByRole('button',{name:'open referenced record',exact:true}).click();await expect(reader(p).locator('[data-placement="show"]')).toHaveText('reveal');await reader(p).getByRole('button',{name:'Back',exact:true}).click();await reader(p).getByRole('button',{name:'hide connection',exact:true}).click();await rest(p,4);
    await expect(list(p).locator('[data-field-reference]')).toHaveCount(2);
    await list(p).getByRole('button',{name:'Evil Walks',exact:true}).press("Enter");await rest(p,4);
    for(const dock of ['reader','tables'])await p.locator(`#source-${dock} .motion-swap__is`).getByRole('button',{name:'close',exact:true}).first().click();await rest(p,4);
    at=await point(p,first.id);await p.mouse.move(at.x,at.y);await p.mouse.down();await p.waitForTimeout(150);await p.mouse.move(at.x-15,at.y+8,{steps:4});await p.mouse.move(at.x-65,at.y+35,{steps:12});await p.mouse.up();await rest(p,4);
    const drop=(await state(p)).nodes.find((n:any)=>n.id===first.id).at;
    expect(drop.slice(0,2)).toEqual([-65,35]);
    await p.mouse.move(width/2,110);await p.mouse.down();await p.waitForTimeout(150);await p.mouse.move(width/2+40,140,{steps:10});await p.mouse.up();await p.mouse.wheel(0,-120);await rest(p,4);
    expect((await state(p)).nodes.find((n:any)=>n.id===first.id).at).toEqual(drop);
    await p.mouse.click(width/2,80);await p.keyboard.press('.');await expect(p.locator('.instrument')).toBeHidden();await p.keyboard.press('.');await expect(p.locator('.instrument')).toBeVisible();
    await list(p).getByRole('button',{name:'Evil Walks',exact:true}).press('Enter');await expect(reader(p).locator('h2')).toHaveAccessibleName('Track, TrackId=10');await rest(p,4);
    expect((await state(p)).nodes.find((n:any)=>n.id===first.id).at).toEqual(drop);expect(errors).toEqual([]);
   }finally{await p.close();}
  });
 });
}
test('canonical is the default; readable labels need an explicit display policy',async({page})=>{
 test.skip(!prepared(),'Prepare pinned Chinook');await serveSource(UPSTREAM,async({origin})=>{
  for (const query of ['']) {
    await track(page,origin,query);const node=(await state(page)).nodes[0];
    expect(node.style.labelText).toBe('Track 10');
    expect(node.style.labelTextBaseline).toBe('middle');expect(node.style.labelOffsetY).toBe(2);
    expect(node.style.labelPlacement).toBe('center');
  }
 });
});
test('disposable self/composite/parallel observations retain distinct selectable ownership',async({page})=>{
 const folder=await mkdtemp(join(tmpdir(),'ki-canonical-prototype-')),db=join(folder,'fixture.sqlite');
 execFileSync('python3',['-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript("""CREATE TABLE Parent(a INTEGER,b INTEGER,PRIMARY KEY(a,b));INSERT INTO Parent VALUES(1,2);
CREATE TABLE Child(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER,p INTEGER REFERENCES Child(id),FOREIGN KEY(a,b) REFERENCES Parent(a,b),FOREIGN KEY(a,b) REFERENCES Parent(a,b));INSERT INTO Child VALUES(1,1,2,1);
CREATE TABLE ParentA(id INTEGER PRIMARY KEY);INSERT INTO ParentA VALUES(1);CREATE TABLE ParentB(id INTEGER PRIMARY KEY);INSERT INTO ParentB VALUES(1);
CREATE TABLE Crowded(id INTEGER PRIMARY KEY,parent_a INTEGER REFERENCES ParentA(id),parent_b INTEGER REFERENCES ParentB(id));INSERT INTO Crowded VALUES(1,1,1);""");c.close()`,db]);
 try{await serveSource(db,async({origin})=>{
  await page.goto(origin+'/source');await table(page).getByRole('button',{name:'Child table',exact:true}).click();await table(page).getByRole('button',{name:'Inspect row 1',exact:true}).click();await reader(page).locator('[data-placement="show"]').click();
  for(let i=0;i<3;i++){await openSourceReferences(page); await reader(page).locator('.source-outgoing article').nth(i).getByRole('button',{name:/inspect FK/}).click();await reader(page).locator('[data-reference-show]').click();await reader(page).getByRole('button',{name:'Back',exact:true}).click();}
  await rest(page,2);const s=await state(page);expect(s.edges).toHaveLength(6);expect(new Set(s.edges.map((e:any)=>e.id)).size).toBe(6);expect(s.edges.filter((e:any)=>e.id.startsWith('source-summary:'))).toHaveLength(1);expect(s.nodes.map((n:any)=>n.style.labelText)).toContain('Parent a=1; b=2');
  await expect(list(page).locator('[data-field-reference]')).toHaveCount(3);
  const self=s.edges.find((e:any)=>e.source===e.target&&e.style.lineWidth===1);expect(self?.path.some((c:any)=>c[0]==='C')).toBe(true);
  await list(page).locator('[data-field-reference]').first().press("Enter");await reader(page).getByRole('button',{name:'hide connection',exact:true}).click();await expect(list(page).locator('[data-field-reference]')).toHaveCount(2);await rest(page,2);
  // A fresh canvas for the second fixture, not the one kept from the first (O8.8).
  await forgetSourceCanvas(page,origin);await page.goto(origin+'/source?canvas=canonical');await table(page).getByRole('button',{name:'Crowded table',exact:true}).click();await table(page).getByRole('button',{name:'Inspect row 1',exact:true}).click();await reader(page).locator('[data-placement="show"]').click();
  for(let i=0;i<2;i++){await openSourceReferences(page); await reader(page).locator('.source-outgoing article').nth(i).getByRole('button',{name:/inspect FK/}).click();await reader(page).locator('[data-reference-show]').click();await reader(page).getByRole('button',{name:'Back',exact:true}).click();}
  await rest(page,3);
  for(const dock of ['reader','tables'])await page.locator(`#source-${dock} .motion-swap__is`).getByRole('button',{name:'close',exact:true}).first().click();await rest(page,3);
  const crowded=await state(page),anchor=crowded.nodes.find((n:any)=>n.style.labelText.startsWith('Crowded'))!,parent=crowded.nodes.find((n:any)=>n.style.labelText.startsWith('ParentA'))!;
  const other=crowded.nodes.find((n:any)=>n.style.labelText.startsWith('ParentB'))!;
  const a=await point(page,other.id),b=await point(page,parent.id);
  await page.mouse.move(b.x,b.y);await page.mouse.down();await page.waitForTimeout(150);await page.mouse.move(a.x+134,a.y-134,{steps:20});await page.mouse.up();await rest(page,3);
  // Hover names the neighborhood; only selection owns a spreading fan.
  await page.mouse.click(720,80);await rest(page,3);
  const hovered=await point(page,anchor.id);await page.mouse.move(hovered.x,hovered.y);await rest(page,3);
  const hoverState=await state(page);
  expect(hoverState.edges.filter((e:any)=>!e.id.startsWith('source-carrier:')&&!e.id.startsWith('source-summary:')).every((e:any)=>e.style.labelOpacity===1)).toBe(true);
  expect(hoverState.edges.filter((e:any)=>e.id.startsWith('source-carrier:')).every((e:any)=>e.path.length===2)).toBe(true);
  await list(page).getByRole('button',{name:'Crowded 1',exact:true}).press("Enter");await rest(page,3);
  await expect.poll(async()=>(await state(page)).edges.filter((e:any)=>e.id.startsWith('source-carrier:')).some((e:any)=>e.path.length===3)).toBe(true);
  expect((await state(page)).nodes.find((n:any)=>n.id===anchor.id).at).toEqual(anchor.at);
 });}finally{await rm(folder,{recursive:true,force:true});}
});
