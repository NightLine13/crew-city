// Crew City · Customise screen (to-do #1, character customization). PREVIEW module, round 2 (manifest v2, 12 rows).
// Self-contained: load after the main city script (needs window.__avatars, window.__world, bakeAvatar/bakeAvatarActs,
// and — for pets — the page's update/PROPS/drawPersonA globals). Works on v16 (v18 page) and v17 (v19 page).
//
// Data-driven: every row, option, layer, palette and pet comes from Edith's characters/manifest.json (version 2, rows[]).
// Adding a row/option there needs no code change. Compositing follows SPEC v2.4 / tools/compose2.py exactly.
// Rules: you only edit YOUR OWN avatar (the player). Saves go to localStorage as {bot, v:2, picks:{rowId:optionId}, updated_at}.
// Shared looks (v19): when signed in, SAVE also upserts your row in public.crew_looks (sql/v19_looks.sql; RLS: everyone
// reads, only the owner writes). On load every row is read and applied, so everyone sees each other's look + pet in the
// city and inside rooms. If the table is missing / unreachable, everything falls back to localStorage (own look only).
// Walking never touches the network; reads happen on load, when the tab comes back, and every CFG.remoteRefreshMs.
(function(){
'use strict';
const CFG=Object.assign({
  base:'avatar-design/custom/characters/',   // Edith's design folder (copy to assets/custom/ when publishing)
  storagePrefix:'crewcity.look.',             // localStorage key = prefix + bot
  previewScale:4,
  autoButton:true,
  pets:true,
  remote:true,                                // shared looks via public.crew_looks (falls back to localStorage)
  remoteTable:'crew_looks',
  remoteRefreshMs:5*60*1000
},window.CC_CUSTOMIZE_CONFIG||{});

const DIRS=['S','SE','E','NE','N','NW','W','SW'];
const DIR_NAMES={S:'FRONT',SE:'FRONT-RIGHT',E:'RIGHT',NE:'BACK-RIGHT',N:'BACK',NW:'BACK-LEFT',W:'LEFT',SW:'FRONT-LEFT'};
const KIND_ORDER={keyed:0,clip:1,front:2};
const S={data:null,rows:[],bot:null,state:null,saved:null,dir:0,sel:0,isOpen:false,el:null,
  imgs:new Map(),blobUrls:{},orig:{},applied:null,status:'',petTimer:null};
const hooks={saveRemote:null,loadRemote:null,onApplied:null};
const REMOTE={table:null,rows:{},loads:0,saves:0,lastError:null,lastStatus:null,applied:{}};

// ---------- helpers ----------
const fill=(t,bot,sfx)=>String(t).replace(/\{bot\}/g,bot).replace(/\{sfx\}/g,sfx||'');
const hexInt=h=>parseInt(String(h).replace('#',''),16);
function getJSON(u){return fetch(u,{cache:'no-cache'}).then(r=>{if(!r.ok)throw new Error(u+' '+r.status);return r.json();});}
function loadImg(src){
  if(S.imgs.has(src))return S.imgs.get(src);
  const p=new Promise(res=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>res(null);im.src=src;});
  S.imgs.set(src,p);return p;
}
function canvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.imageSmoothingEnabled=false;return[c,g];}
function ownBot(){const p=window.__world&&window.__world.player;return(p&&p.id)||'suvi';}
function avatarsApi(){return window.__avatars||null;}

// ---------- data (manifest v2) ----------
async function loadData(){
  const b=CFG.base;
  const manifest=await getJSON(b+'manifest.json');
  if(!(manifest.version>=2&&Array.isArray(manifest.rows)))throw new Error('manifest v2 (rows[]) required; got version '+manifest.version);
  const files=Object.assign({core:'options/base/{bot}{sfx}_core.png',default_palette:'default_palettes_r2.json',option_palettes:'options_palettes.json'},manifest.files||{});
  const [palettes,opal,swatches,petsJson]=await Promise.all([getJSON(b+files.default_palette),getJSON(b+files.option_palettes).catch(()=>({})),getJSON(b+'swatches.json').catch(()=>({})),
    getJSON(b+(files.pets||'pets/pets.json')).catch(()=>null)]);
  const swatchById={};for(const list of Object.values(swatches||{}))for(const sw of list||[])if(!swatchById[sw.id])swatchById[sw.id]=sw;
  const petsById={};for(const q of (petsJson&&petsJson.pets)||[])petsById[q.id]=q;
  S.data={manifest,palettes,opal,files,swatchById,frame:manifest.frame||{w:72,h:136,feetX:40},petsById,petScale:(petsJson&&petsJson.map_scale)||3/8};
  return S.data;
}
function available(row,bot){return(row.options||[]).filter(o=>(!o.available_for||o.available_for.includes(bot))&&!(o.unavailable_for&&Object.prototype.hasOwnProperty.call(o.unavailable_for,bot)));}
function paletteOf(o,bot){
  if(!o||!o.palette)return null;
  const ref=String(o.palette),path=fill(ref.includes('#')?ref.split('#')[1]:ref,bot).split('/');
  let cur=S.data.opal;for(const k of path){cur=cur&&cur[k];}
  return cur&&typeof cur==='object'?cur:null;
}
function chipsOf(o,bot){
  if(o.swatch&&S.data.swatchById[o.swatch])return S.data.swatchById[o.swatch].ramp.slice(1,4);
  const p=paletteOf(o,bot);if(!p)return null;
  const vals=[...new Set(Object.values(p))];if(!vals.length)return null;
  const lum=h=>{const v=hexInt(h);return(v>>16&255)*.3+(v>>8&255)*.59+(v&255)*.11;};vals.sort((a,b)=>lum(a)-lum(b));
  const pick=n=>vals[Math.min(vals.length-1,Math.round(n*(vals.length-1)))];
  return[pick(.3),pick(.55),pick(.8)];
}
// pets.json is the source of truth for pet geometry: anchor/feet, sort_y, bbox, sizes (manifest copy is the fallback)
function petSpec(raw){
  if(!raw)return null;const q=Object.assign({},raw,S.data.petsById[raw.id]||{});
  const a=q.feet&&q.feet.x!=null?[q.feet.x,q.feet.y]:(q.anchor||[q.frame.w/2,q.frame.h-1]);
  q.ax=a[0];q.ay=a[1];q.sortY=q.sort_y!=null?q.sort_y:a[1];q.scale=q.map_scale||S.data.petScale||3/8;
  return q;
}
function buildRows(bot){
  return S.data.manifest.rows.map(r=>{
    const opts=available(r,bot);
    return{id:r.id,label:r.label||r.id,none:!!r.none,isPet:opts.some(o=>o.pet),
      options:opts.map(o=>({key:o.id,label:o.label||o.id,raw:o,chips:chipsOf(o,bot),pet:petSpec(o.pet)})),
      inert:opts.length<2};
  });
}

// ---------- profile ----------
function defaultPicks(bot){const P={};for(const r of S.data.manifest.rows){const a=available(r,bot);if(a.length)P[r.id]=a[0].id;}return P;}
function emptyProfile(bot){return{bot,v:2,picks:{},updated_at:null};}
// v1 (round 1) saves: keep what still maps (accessories → Accessories/Glasses row); v1 colours have no v2 twin, so they drop.
function fromV1(p){const picks={};for(const a of p.accessories||[]){if(a==='shades')picks.glasses='shades';else picks.accessories=a;}return{bot:p.bot,v:2,picks,updated_at:p.updated_at||null};}
function normalize(p,bot){
  const out=emptyProfile(bot);
  if(!p||typeof p!=='object')return out;
  if(p.bot&&p.bot!==bot)return out;                       // a user may only hold their own bot's look
  if(!p.picks&&(p.colors||p.accessories))p=fromV1(p);
  const def=defaultPicks(bot);
  for(const r of S.data.manifest.rows){
    const id=p.picks&&p.picks[r.id];if(id==null)continue;
    if(!available(r,bot).some(o=>o.id===id))continue;     // unknown or not-for-this-bot ids are ignored
    if(id!==def[r.id])out.picks[r.id]=id;                 // only store changes from Option 1
  }
  if(p.updated_at)out.updated_at=String(p.updated_at);
  return out;
}
function isDefault(p){return!p||!Object.keys(p.picks||{}).length;}
function sig(p){return JSON.stringify(Object.entries((p&&p.picks)||{}).sort());}
function rowIndex(row,p){const k=(p.picks||{})[row.id];const i=k==null?0:row.options.findIndex(o=>o.key===k);return i<0?0:i;}
function setRow(p,row,idx){
  const o=row.options[idx];if(!o)return p;
  const q={...p,picks:{...p.picks}};q.picks[row.id]=o.key;
  return normalize(q,q.bot);
}
function storageKey(bot){return CFG.storagePrefix+bot;}
function loadLocal(bot){try{const raw=localStorage.getItem(storageKey(bot));return raw?normalize(JSON.parse(raw),bot):emptyProfile(bot);}catch(e){return emptyProfile(bot);}}
function petOf(bot,p){const r=S.data.manifest.rows.find(x=>x.id==='pets'||(x.options||[]).some(o=>o.pet));if(!r)return null;
  const id=Object.assign(defaultPicks(bot),(p&&p.picks)||{})[r.id];const o=(r.options||[]).find(x=>x.id===id);return o&&o.pet?petSpec(o.pet):null;}

// ---------- compositing (SPEC v2.4 / compose2.py) ----------
async function compose(bot,p,which){
  which=which||'main';const acts=which==='acts',sfx=acts?'-acts':'';
  p=normalize(p,bot);
  const D=S.data,P=Object.assign(defaultPicks(bot),p.picks);
  const pal=Object.assign({},D.palettes[bot]||{}),layers=[];
  for(const r of D.manifest.rows){
    const o=(r.options||[]).find(x=>x.id===P[r.id]);if(!o||o.pet)continue;
    const po=paletteOf(o,bot);if(po)Object.assign(pal,po);
    for(const l of o.layers||[]){const t=acts?l.acts:l.sheet;if(!t)continue;
      layers.push({z:l.z||0,kind:l.kind,src:CFG.base+fill(t,bot,sfx),after:acts?null:(l.after_hair_dirs||null)});}
  }
  const core=await loadImg(CFG.base+fill(D.files.core,bot,sfx));if(!core)return null;
  const W=core.naturalWidth,H=core.naturalHeight,fw=(D.frame&&D.frame.w)||72;
  const c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d',{willReadFrequently:true});g.imageSmoothingEnabled=false;
  const imgs=await Promise.all(layers.map(l=>loadImg(l.src)));layers.forEach((l,i)=>l.img=imgs[i]);
  // every layer pixel is alpha 0 or 255 (checked), so source-over == "opaque pixels overwrite"
  const back=layers.filter(l=>l.kind==='back').sort((a,b)=>a.z-b.z);
  for(const l of back)if(l.img)g.drawImage(l.img,0,0);
  g.drawImage(core,0,0);
  const rest=layers.map((l,i)=>[l,i]).filter(([l])=>l.kind!=='back').sort((a,b)=>a[0].z-b[0].z||(KIND_ORDER[a[0].kind]||0)-(KIND_ORDER[b[0].kind]||0)||a[1]-b[1]).map(x=>x[0]);
  const late=[];
  const cols=(im,set,want)=>{for(let ci=0;ci<DIRS.length;ci++)if(set.has(ci)===want)g.drawImage(im,ci*fw,0,fw,H,ci*fw,0,fw,H);};
  for(const l of rest){
    if(!l.img)continue;
    if(l.kind==='clip'){g.globalCompositeOperation='destination-out';g.drawImage(l.img,0,0);g.globalCompositeOperation='source-over';continue;}
    if(l.after&&l.after.length){const set=new Set(l.after.map(d=>DIRS.indexOf(d)));cols(l.img,set,false);late.push([l.img,set]);continue;}
    g.drawImage(l.img,0,0);
  }
  for(const[im,set]of late)cols(im,set,true);
  // one palette pass over the whole composite (keys not in the palette stay as-is)
  const map=new Map();for(const[k,v]of Object.entries(pal))map.set(hexInt(k),hexInt(v));
  const id=g.getImageData(0,0,W,H),d=id.data;
  for(let i=0;i<d.length;i+=4){
    if(!d[i+3]||d[i+2]!==254)continue;
    const v=map.get((d[i]<<16)|(d[i+1]<<8)|254);
    if(v!==undefined){d[i]=v>>16&255;d[i+1]=v>>8&255;d[i+2]=v&255;}
  }
  g.putImageData(id,0,0);
  return c;
}
// bakeAvatar() wants a loaded <img> (complete + naturalWidth), so go through a blob URL first.
function canvasToImage(c,slot){
  return new Promise(res=>{c.toBlob(b=>{if(!b)return res(null);
    const url=URL.createObjectURL(b),im=new Image();
    im.onload=()=>{if(S.blobUrls[slot])URL.revokeObjectURL(S.blobUrls[slot]);S.blobUrls[slot]=url;res(im);};
    im.onerror=()=>{URL.revokeObjectURL(url);res(null);};im.src=url;},'image/png');});
}
function bake(spec,which){
  if(which==='acts'){spec.actsBaked=null;if(typeof bakeAvatarActs==='function')bakeAvatarActs(spec);}
  else{spec.baked=null;if(typeof bakeAvatar==='function')bakeAvatar(spec);}
}
// Put a look (and pet) on a city sprite. The Customise screen only ever calls this for the player's own bot;
// shared looks (crew_looks rows, read-only here) call it for the other crew so everyone sees each other's look.
async function applyToCity(bot,p){
  const A=avatarsApi(),spec=A&&A.sprites&&A.sprites[bot];if(!spec)return false;
  if(spec.ready)await spec.ready;
  if(!S.orig[bot])S.orig[bot]={img:spec.img,act:spec.actImg};
  p=normalize(p,bot);
  const pet=petOf(bot,p);
  const lookOnly={...p,picks:Object.fromEntries(Object.entries(p.picks).filter(([r])=>!S.data.manifest.rows.find(x=>x.id===r&&(x.options||[]).some(o=>o.pet))))};
  if(isDefault(lookOnly)){                            // Option 1 everywhere = the approved live sheet, untouched
    const o=S.orig[bot];
    if(o.img){spec.img=o.img;spec.ok=!spec.failed;bake(spec,'main');}
    if(o.act){spec.actImg=o.act;spec.actsOk=true;bake(spec,'acts');}
  }else{
    const[mc,ac]=await Promise.all([compose(bot,p,'main'),compose(bot,p,'acts')]);
    if(!mc)return false;                              // design files missing: keep the live sheet
    const[mi,ai]=await Promise.all([canvasToImage(mc,bot+':main'),ac?canvasToImage(ac,bot+':acts'):null]);
    if(!mi)return false;
    spec.img=mi;if(!spec.failed)spec.ok=true;bake(spec,'main');
    if(ai){spec.actImg=ai;spec.actsOk=true;bake(spec,'acts');}
  }
  if(bot===ownBot()){await PET.set(pet);S.applied={bot,profile:p,default:isDefault(lookOnly),pet:pet?pet.id:null};}
  else{await crewPet(bot).set(pet);REMOTE.applied[bot]={profile:p,default:isDefault(lookOnly),pet:pet?pet.id:null};}
  if(typeof hooks.onApplied==='function')try{hooks.onApplied(bot,p);}catch(e){}
  return true;
}

// ---------- pets (SPEC v2.6) — client-side only, never blocks, never clickable ----------
function makePet(opt){
  opt=opt||{};const isPlayer=!opt.owner;
  const P={spec:null,sheet:null,baked:null,bw:0,bh:0,scale:3/8,x:0,y:0,face:'S',moving:false,t:0,trail:[],
    mode:'street',hidden:true,frames:new Map(),inRoomKey:null,lastOwner:null,stats:{ticks:0,streetDraws:0,roomDraws:0}};
  const TILE=8;               // 1 tile of path length = 16 art px = 8 logical units
  const OWNER_SPEED=72;       // the engine's walk speed (logical units / s)
  const blank=document.createElement('canvas');blank.width=blank.height=1;
  async function set(spec){
    if(!spec){P.spec=null;P.baked=null;P.frames.clear();return;}
    if(P.spec&&P.spec.id===spec.id&&P.baked)return;
    const im=await loadImg(CFG.base+spec.sheet);if(!im){P.spec=null;P.baked=null;return;}
    P.scale=spec.scale||3/8;const fw=spec.frame.w,fh=spec.frame.h,dw=Math.round(fw*P.scale),dh=Math.round(fh*P.scale);
    const[c,g]=canvas((spec.cols||DIRS).length*dw,Math.round(im.naturalHeight/fh)*dh);
    g.drawImage(im,0,0,im.naturalWidth,im.naturalHeight,0,0,c.width,c.height);   // same 0.375 nearest bake as the avatars
    P.spec=spec;P.sheet=im;P.baked=c;P.bw=dw;P.bh=dh;P.frames.clear();
    const o=owner();if(o)snapBehind(o);
  }
  function inRoom(){return!!(window.__v17&&window.__v17.on);}
  function owner(){
    if(!isPlayer)return opt.owner();
    if(inRoom()){const m=window.__v17.me;return{x:m.x,y:m.y,face:m.face||'S',moving:!!m.moving,room:window.__v17.id};}
    const p=window.__world&&window.__world.player;if(!p)return null;
    return{x:p.x,y:p.y,face:p.face||'S',moving:!!p.moving,room:null};
  }
  const BACK={S:[0,-1],SE:[-1,-1],E:[-1,0],NE:[-1,1],N:[0,1],NW:[1,1],W:[1,0],SW:[1,-1]};
  function snapBehind(o){const b=BACK[o.face]||[0,-1],l=Math.hypot(b[0],b[1])||1;
    P.x=o.x+b[0]/l*TILE;P.y=o.y+b[1]/l*TILE;P.face=o.face;P.moving=false;P.trail=[{x:P.x,y:P.y},{x:o.x,y:o.y}];}
  // point on the trail `dist` of path length behind the newest point (the owner's feet)
  function trailPoint(dist){
    const tr=P.trail;let left=dist;
    for(let i=tr.length-1;i>0;i--){const a=tr[i],b=tr[i-1],seg=Math.hypot(a.x-b.x,a.y-b.y);
      if(seg>=left){const k=seg?left/seg:0;return{x:a.x+(b.x-a.x)*k,y:a.y+(b.y-a.y)*k};}left-=seg;}
    return tr[0]?{...tr[0]}:null;
  }
  function tick(dt){
    if(!P.spec||!P.baked){P.hidden=true;return;}
    if(P.hold){P.hidden=false;return;}                                  // test/photo hook: pet pinned in place
    const o=owner();if(!o){P.hidden=true;return;}
    const insideStreet=isPlayer&&!inRoom()&&typeof DOORS!=='undefined'&&DOORS.inside;   // v16: no room view, owner is hidden
    const key=o.room||'street';
    if(key!==P.inRoomKey){P.inRoomKey=key;snapBehind(o);}               // came in / went out: reappear 1 tile behind
    P.hidden=!!insideStreet;if(P.hidden)return;
    if(o.still){P.x=o.x+TILE*1.25;P.y=o.y+1;P.face='S';P.moving=false;P.trail=[{x:P.x,y:P.y}];P.dist=Math.hypot(o.x-P.x,o.y-P.y);P.stats.ticks++;return;} // crew host/guest standing in a room: pet sits beside them
    P.stats.ticks++;
    const tr=P.trail,last=tr[tr.length-1];
    if(!last||Math.hypot(o.x-last.x,o.y-last.y)>0.5)tr.push({x:o.x,y:o.y});
    else{last.x=o.x;last.y=o.y;}
    // drop points older than ~3 tiles of path
    let len=0;for(let i=tr.length-1;i>0;i--){len+=Math.hypot(tr[i].x-tr[i-1].x,tr[i].y-tr[i-1].y);if(len>TILE*3.5){tr.splice(0,i-1);break;}}
    if(Math.hypot(o.x-P.x,o.y-P.y)>TILE*6){snapBehind(o);return;}       // teleports (setPos, door exit) → snap
    const tgt=trailPoint(TILE)||{x:o.x,y:o.y};
    const vx=tgt.x-P.x,vy=tgt.y-P.y,d=Math.hypot(vx,vy),max=1.15*OWNER_SPEED*dt;
    if(d>0.35){const s=Math.min(max,d);const mx=vx/d*s,my=vy/d*s;P.x+=mx;P.y+=my;P.moving=true;P.t+=dt;
      const f=(typeof dir8FromVel==='function')?dir8FromVel(mx,my):null;if(f)P.face=f;}
    else{P.moving=false;}
    P.dist=Math.hypot(o.x-P.x,o.y-P.y);
  }
  function frameCanvas(){
    const sp=P.spec;if(!sp||!P.baked)return blank;
    const cols=sp.cols||DIRS,ci=Math.max(0,cols.indexOf(P.face));
    const rows=P.moving?sp.rows.walk:sp.rows.idle,fps=P.moving?sp.fps.walk:sp.fps.idle;
    const tt=P.moving?P.t:((typeof T==='number')?T:performance.now()/1000);
    const ri=rows[Math.floor(tt*fps)%rows.length];
    const k=ci+'|'+ri;let c=P.frames.get(k);if(c)return c;
    // frame + a small soft shadow under the feet, baked once per frame
    const pad=2;[c]=canvas(P.bw+pad*2,P.bh+pad*2);const g=c.getContext('2d');g.imageSmoothingEnabled=false;
    const ax=sp.ax*P.scale,ay=sp.ay*P.scale;
    g.fillStyle='rgba(5,2,14,.45)';g.beginPath();g.ellipse(pad+ax,pad+ay,5,2,0,0,Math.PI*2);g.fill();
    g.drawImage(P.baked,ci*P.bw,ri*P.bh,P.bw,P.bh,pad,pad,P.bw,P.bh);
    P.frames.set(k,c);return c;
  }
  function offs(){const sp=P.spec,pad=2;return[Math.round((sp?sp.ax:24)*P.scale)+pad,Math.round((sp?sp.ay:47)*P.scale)+pad];}
  const kk=()=>(typeof K==='number'?K:2);
  // depth key in logical units = worldY of the frame's sort_y row (== the feet line, so == P.y when sort_y == anchor y)
  function sortKey(){const sp=P.spec;return P.y+(sp?(sp.sortY-sp.ay)*P.scale/kk():0);}
  // street: a PROPS entry whose fields are live, so the engine y-sorts it by the pet's feet y (no collision, no markRect)
  const prop={get y(){return sortKey();},get c(){if(P.hidden||inRoom()||!P.spec)return blank;P.stats.streetDraws++;return frameCanvas();},
    get ax(){return Math.round(P.x*kk())-offs()[0];},get ay(){return Math.round(P.y*kk())-offs()[1];},ccPet:true};
  function drawAt(g,X,Y){if(!P.spec||P.hidden)return;P.stats.roomDraws++;const[ox,oy]=offs();g.drawImage(frameCanvas(),Math.round(X)-ox,Math.round(Y)-oy);}
  function install(){
    if(!CFG.pets)return false;
    if(typeof PROPS!=='undefined'&&Array.isArray(PROPS)&&!PROPS.includes(prop))PROPS.push(prop);
    if(!isPlayer){(window.__roomEntHooks=window.__roomEntHooks||[]).push((ents,c)=>{if(!P.spec||P.hidden||!inRoom()||P.inRoomKey==='street')return;
      ents.push({y:sortKey(),ccPet:opt.id,f:()=>drawAt(c.g,P.x*c.K+c.ox,P.y*c.K+c.oy)});});return true;}
    if(typeof update==='function'&&!update.__ccPet){const u=update;update=function(dt){u.apply(this,arguments);try{tick(dt||0);}catch(e){}};update.__ccPet=true;}
    // rooms: v19's room renderer calls window.__roomEntHooks before its y-sort, so the pet joins furniture, the computer
    // and avatars in one depth sort (key = sortKey()). Pages without that hook fall back to sorting against "me" only.
    (window.__roomEntHooks=window.__roomEntHooks||[]).push((ents,c)=>{
      P.roomHooked=true;if(!P.spec||P.hidden)return;
      const ent={y:sortKey(),ccPet:true,f:()=>drawAt(c.g,P.x*c.K+c.ox,P.y*c.K+c.oy)};ents.push(ent);
      if(P.recordOrder){P.recordOrder=false;const log=[];P.lastOrder=log;
        for(const e of ents){const f=e.f,y=e.y,pet=!!e.ccPet;e.f=function(){log.push({y,pet});return f.apply(this,arguments);};}}
    });
    if(typeof drawPersonA==='function'&&!drawPersonA.__ccPet){const dp=drawPersonA;
      drawPersonA=function(g,ax,ay,sp,dir,f,ent){
        const room=inRoom()&&ent&&ent.id===ownBot()&&(typeof PLAYER==='undefined'||ent!==PLAYER);
        if(!room||!P.spec||P.roomHooked)return dp.apply(this,arguments);
        const k=kk(),X=P.x*k+(ax-ent.x*k),Y=P.y*k+(ay-ent.y*k);   // same camera offset as the owner
        if(sortKey()<ent.y)drawAt(g,X,Y);const r=dp.apply(this,arguments);if(sortKey()>=ent.y)drawAt(g,X,Y);return r;};
      drawPersonA.__ccPet=true;}
    return true;
  }
  return{set,tick,install,drawAt,frameCanvas,P,get id(){return opt.id||ownBot();},
    state(){return{id:P.spec&&P.spec.id||null,x:P.x,y:P.y,face:P.face,moving:P.moving,hidden:P.hidden||!P.spec,mode:inRoom()?'room':'street',dist:P.dist==null?null:P.dist,trail:P.trail.length,inProps:typeof PROPS!=='undefined'&&PROPS.includes(prop),stats:{...P.stats}};},
    snap(){const o=owner();if(o)snapBehind(o);},
    // test / photo hooks (local only)
    place(x,y,face){P.x=x;P.y=y;if(face)P.face=face;P.moving=false;P.hold=true;},release(){P.hold=false;const o=owner();if(o)snapBehind(o);},
    recordOrder(){P.recordOrder=true;},get lastOrder(){return P.lastOrder||null;},get sortKey(){return sortKey();},
    async lineup(ids,x,y,gap,face){            // static idle pets as street props, for a lineup photo
      const out=[];for(const[i,id]of ids.entries()){const r=S.data.manifest.rows.find(q=>q.id==='pets');const o=r&&r.options.find(q=>q.pet&&q.pet.id===id);const sp=o&&petSpec(o.pet);if(!sp)continue;
        const im=await loadImg(CFG.base+sp.sheet);if(!im)continue;const sc=sp.scale,fw=sp.frame.w,fh=sp.frame.h,dw=Math.round(fw*sc),dh=Math.round(fh*sc),k=kk();
        const ci=Math.max(0,(sp.cols||DIRS).indexOf(face||'S'));const[c,g]=canvas(dw+4,dh+4);
        g.fillStyle='rgba(5,2,14,.45)';g.beginPath();g.ellipse(2+sp.ax*sc,2+sp.ay*sc,5,2,0,0,Math.PI*2);g.fill();
        g.drawImage(im,ci*fw,sp.rows.idle[0]*fh,fw,fh,2,2,dw,dh);
        const px=x+i*gap,pr={y:y,c,ax:Math.round(px*k)-Math.round(sp.ax*sc)-2,ay:Math.round(y*k)-Math.round(sp.ay*sc)-2,ccLineup:id};PROPS.push(pr);out.push({id,h:sp.map_height_px,x:px});}
      return out;},
    clearLineup(){for(let i=PROPS.length-1;i>=0;i--)if(PROPS[i].ccLineup)PROPS.splice(i,1);}};
}
const PET=makePet();
// ---------- crew pets (shared looks): one follower per other crew member that has a pet in crew_looks ----------
const CREW_PETS=new Map();
function crewOwner(bot){
  const V=window.__v17;
  if(V&&V.on){const q=(V.people||[]).find(x=>x.id===bot);return q?{x:q.x,y:q.y,face:'S',moving:false,still:true,room:V.id}:null;}
  const W=window.__world,n=W&&(W.npcs||[]).find(m=>m.id===bot);if(!n||n.hidden)return null;
  const A=avatarsApi();return{x:n.x,y:n.y,face:n.face||(A&&A.dir4To8?A.dir4To8(n.dir):'S')||'S',moving:!!n.moving,room:null};
}
function crewPet(bot){
  let q=CREW_PETS.get(bot);if(q)return q;
  q=makePet({id:bot,owner:()=>crewOwner(bot)});CREW_PETS.set(bot,q);
  q.install();
  // one shared tick for every crew pet, chained after the player's pet tick (no network, no usage)
  if(typeof update==='function'&&!update.__ccCrewPets){const u=update;update=function(dt){u.apply(this,arguments);for(const c of CREW_PETS.values())try{c.tick(dt||0);}catch(e){}};update.__ccCrewPets=true;}
  return q;
}

// ---------- shared looks: public.crew_looks (sql/v19_looks.sql) ----------
// Read: anyone (anon key). Write: only the signed-in owner of the row (RLS: bot = crew_whoami()). Never writes for anyone else.
function sbBase(){try{if(typeof CHAT_URL!=='undefined'&&CHAT_URL)return CHAT_URL;}catch(e){}try{if(typeof WORLD_URL!=='undefined'&&WORLD_URL)return WORLD_URL;}catch(e){}return null;}
function sbKey(){try{if(typeof WORLD_KEY!=='undefined'&&WORLD_KEY)return WORLD_KEY;}catch(e){}return null;}
function signedIn(){return!!(window.__auth&&window.__auth.state==='in');}
function anonHeaders(){const k=sbKey();return k?{apikey:k,Authorization:'Bearer '+k}:null;}
function ownerHeaders(){if(!signedIn()||typeof authHeaders!=='function')return null;try{return authHeaders();}catch(e){return null;}}
const MISSING=/PGRST205|PGRST202|42P01|does not exist|Could not find the table/i;
async function tableMissing(r){if(r.status===404)return true;try{const t=await r.clone().text();return MISSING.test(t);}catch(e){return false;}}
const LOOK_IDS=()=>{const A=avatarsApi();return(A&&A.ids)||['edith','anissa','gigi','yugi','buzz','suvi'];};
async function loadRemoteDefault(){
  const base=sbBase(),hd=anonHeaders();if(!CFG.remote||!base||!hd)return null;
  REMOTE.loads++;
  const r=await fetch(base+'/rest/v1/'+CFG.remoteTable+'?select=bot,picks,v,updated_at&order=bot',{headers:hd,cache:'no-cache'});
  if(!r.ok){if(await tableMissing(r))REMOTE.table=false;throw new Error('crew_looks '+r.status);}
  const rows=await r.json();if(!Array.isArray(rows))throw new Error('crew_looks: unexpected reply');
  REMOTE.table=true;
  return rows.filter(x=>x&&LOOK_IDS().includes(x.bot)&&x.picks&&typeof x.picks==='object').map(x=>({bot:x.bot,v:2,picks:x.picks,updated_at:x.updated_at||null}));
}
async function saveRemoteDefault(p){
  const base=sbBase(),hd=ownerHeaders();
  if(!CFG.remote||!base)return{ok:false,reason:'off'};
  if(!hd)return{ok:false,reason:'signed-out'};
  if(REMOTE.table===false)return{ok:false,reason:'no-table'};
  if(!p||p.bot!==ownBot())return{ok:false,reason:'not-owner'};   // own row only (RLS refuses anything else anyway)
  REMOTE.saves++;
  const r=await fetch(base+'/rest/v1/'+CFG.remoteTable+'?on_conflict=bot',{method:'POST',
    headers:Object.assign({},hd,{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'}),
    body:JSON.stringify({bot:p.bot,picks:p.picks||{}})});
  if(!r.ok){if(await tableMissing(r)){REMOTE.table=false;return{ok:false,reason:'no-table'};}throw new Error('crew_looks save '+r.status);}
  REMOTE.table=true;REMOTE.rows[p.bot]=p;return{ok:true};
}
hooks.saveRemote=saveRemoteDefault;hooks.loadRemote=loadRemoteDefault;
const newer=(a,b)=>(Date.parse(a&&a.updated_at)||0)>(Date.parse(b&&b.updated_at)||0);
// read everyone's row and apply it: other crew -> their look + pet; own bot -> the newer of the DB row and this device's save
async function syncRemote(){
  if(typeof hooks.loadRemote!=='function')return{ok:false,reason:'no-hook'};
  let rows;try{rows=await hooks.loadRemote();}catch(e){REMOTE.lastError=String(e&&e.message||e);REMOTE.lastStatus='fallback';return{ok:false,reason:REMOTE.table===false?'no-table':'error'};}
  if(!Array.isArray(rows)){REMOTE.lastStatus='fallback';return{ok:false,reason:'off'};}
  const me=ownBot(),seen=new Set();
  for(const row of rows){
    const bot=row.bot;if(!LOOK_IDS().includes(bot))continue;seen.add(bot);
    const p=normalize(Object.assign({},row,{bot}),bot);
    if(bot===me){const loc=loadLocal(me);if(newer(p,loc)||(!loc.updated_at&&!isDefault(p))){try{localStorage.setItem(storageKey(me),JSON.stringify(p));}catch(e){}
        if(sig(p)!==sig(S.applied&&S.applied.profile)&&!S.isOpen)await applyToCity(me,p);}
      REMOTE.rows[bot]=p;continue;}
    const prev=REMOTE.rows[bot];REMOTE.rows[bot]=p;
    if(!prev||sig(prev)!==sig(p))await applyToCity(bot,p);
  }
  // a crew member who removed their row goes back to their live look
  for(const bot of Object.keys(REMOTE.rows))if(bot!==me&&!seen.has(bot)){delete REMOTE.rows[bot];await applyToCity(bot,emptyProfile(bot));delete REMOTE.applied[bot];}
  REMOTE.lastStatus='ok';REMOTE.lastError=null;return{ok:true,n:rows.length};
}

// ---------- UI ----------
function h(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
function buildDom(){
  const root=h('div','ccz');root.id='ccz';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','Customise your look');
  root.append(h('div','ccz-sky'),h('div','ccz-floor'));
  const stage=h('div','ccz-stage');
  const brand=h('div','ccz-brand','CREW CITY');brand.append(h('small',null,'you can only change your own look'));
  const wrap=h('div','ccz-avwrap');const av=h('canvas','ccz-av');av.width=72;av.height=136;
  const pet=h('canvas','ccz-pet');pet.width=48;pet.height=48;
  const plat=h('div','ccz-plat');const face=h('div','ccz-face');
  wrap.append(av,pet,plat,face);
  const rl=h('button','ccz-rot l','◀'),rr=h('button','ccz-rot r','▶');
  rl.type=rr.type='button';rl.setAttribute('aria-label','Turn left');rr.setAttribute('aria-label','Turn right');
  stage.append(brand,wrap,rl,rr);
  const panel=h('div','ccz-panel');
  const head=h('div','ccz-head');head.append(h('h2',null,'CUSTOMISE'));
  const x=h('button','ccz-x','✕');x.type='button';x.setAttribute('aria-label','Close');head.append(x);
  const rows=h('div','ccz-rows');rows.setAttribute('role','list');
  const who=h('div','ccz-who');
  const foot=h('div','ccz-foot');const reset=h('button','ccz-reset','RESET'),save=h('button','ccz-save','SAVE');reset.type=save.type='button';
  reset.title='Back to option 1 on every row';foot.append(reset,save);
  const status=h('div','ccz-status');status.setAttribute('role','status');
  panel.append(head,rows,who,foot,status);
  root.append(stage,panel);
  (document.getElementById('ui')||document.body).appendChild(root);
  const stop=e=>{if(S.isOpen)e.stopPropagation();};
  for(const ev of['pointerdown','pointerup','mousedown','mouseup','click','touchstart','touchend','wheel'])root.addEventListener(ev,stop);
  rl.onclick=()=>rotate(-1);rr.onclick=()=>rotate(1);
  x.onclick=()=>close();save.onclick=()=>save_();reset.onclick=()=>{S.state=emptyProfile(S.bot);renderRows();renderPreview();setStatus('Back to option 1 (not saved yet)');};
  S.el={root,av,pet,plat,face,rows,who,save,status};
}
function setStatus(t,err){S.status=t;if(S.el){S.el.status.textContent=t||'';S.el.status.classList.toggle('err',!!err);}}
function valueText(row,idx,o){return(row.id==='hair'?'Style ':'Option ')+(idx+1)+' · '+o.label;}
function renderRows(){
  const R=S.el.rows;R.textContent='';
  S.rows.forEach((row,i)=>{
    const idx=rowIndex(row,S.state),o=row.options[idx];
    const el=h('div','ccz-row'+(row.inert?' soon':'')+(i===S.sel?' sel':''));el.dataset.cat=row.id;el.setAttribute('role','listitem');
    const a=h('button','ccz-arr prev','◀'),b=h('button','ccz-arr next','▶');a.type=b.type='button';
    a.setAttribute('aria-label',row.label+': previous');b.setAttribute('aria-label',row.label+': next');
    a.disabled=b.disabled=!!row.inert;
    const mid=h('div','ccz-mid');mid.append(h('div','ccz-n',row.label));
    const v=h('div','ccz-v');
    if(!o)v.textContent='Coming soon';
    else{v.textContent=valueText(row,idx,o)+(row.inert?' (only option for this character)':'');if(!row.inert)v.append(h('b',null,(idx+1)+'/'+row.options.length));}
    mid.append(v);
    const sw=h('div','ccz-sw');
    if(o&&o.chips){for(const c of o.chips){const s=h('i');s.style.background='#'+c;sw.append(s);}}else sw.classList.add('empty');
    el.append(a,mid,sw,b);
    a.onclick=e=>{e.stopPropagation();S.sel=i;step(row,-1);};
    b.onclick=e=>{e.stopPropagation();S.sel=i;step(row,1);};
    el.onclick=()=>{S.sel=i;for(const r of R.children)r.classList.remove('sel');el.classList.add('sel');};
    R.append(el);
  });
  S.el.who.textContent=S.bot.toUpperCase()+'  ·  MY LOOK'+(sig(S.state)!==sig(S.saved)?'  ·  unsaved':'');
}
function step(row,d){
  if(row.inert)return;
  const n=row.options.length,idx=(rowIndex(row,S.state)+d+n)%n;
  S.state=setRow(S.state,row,idx);
  renderRows();renderPreview();setStatus('');
}
let previewSeq=0;
async function renderPreview(){
  const seq=++previewSeq,c=await compose(S.bot,S.state,'main');
  const petSpec=petOf(S.bot,S.state);
  if(petSpec)await loadImg(CFG.base+petSpec.sheet);
  if(seq!==previewSeq||!c||!S.el)return;
  const fr=S.data.frame,fw=fr.w||72,fh=fr.h||136,col=S.dir,row=0;
  const av=S.el.av,k=previewScaleNow();
  av.width=fw;av.height=fh;av.style.width=(fw*k)+'px';av.style.height=(fh*k)+'px';
  const g=av.getContext('2d');g.imageSmoothingEnabled=false;g.clearRect(0,0,fw,fh);
  g.drawImage(c,col*fw,row*fh,fw,fh,0,0,fw,fh);
  av.style.transform='translateX('+((36-(fr.feetX||40))*k)+'px)';
  const pw=Math.round(fw*k*1.7);S.el.plat.style.width=pw+'px';S.el.plat.style.height=Math.round(pw/4)+'px';S.el.plat.style.marginTop=(-Math.round(pw/4*0.62))+'px';
  S.el.face.textContent='FACING '+DIR_NAMES[DIRS[S.dir]];
  S.previewPet=petSpec;S.previewK=k;drawPreviewPet();
  S.lastPreview={dir:DIRS[S.dir],col,row,sig:sig(S.state),pet:petSpec?petSpec.id:null};
}
// the pet idles on the platform, beside the avatar's feet, facing the same way
function drawPreviewPet(){
  const el=S.el&&S.el.pet;if(!el)return;const sp=S.previewPet,k=S.previewK||3;
  if(!sp){el.style.display='none';return;}
  const im=S.imgs.get(CFG.base+sp.sheet);
  Promise.resolve(im).then(img=>{if(!img||S.previewPet!==sp)return;
    const fw=sp.frame.w,fh=sp.frame.h,cols=sp.cols||DIRS,ci=Math.max(0,cols.indexOf(DIRS[S.dir]));
    const ri=sp.rows.idle[Math.floor(performance.now()/1000*sp.fps.idle)%sp.rows.idle.length];
    el.width=fw;el.height=fh;const g=el.getContext('2d');g.imageSmoothingEnabled=false;g.clearRect(0,0,fw,fh);
    g.drawImage(img,ci*fw,ri*fh,fw,fh,0,0,fw,fh);
    el.style.display='block';el.style.width=(fw*k)+'px';el.style.height=(fh*k)+'px';
    // feet on the avatar's baseline, ~0.75 avatar-width to its side
    const av=S.el.av;el.style.left=(av.offsetLeft+av.offsetWidth*0.78)+'px';el.style.top=(av.offsetTop+av.offsetHeight-(sp.ay+5)*k)+'px';
  });
}
function previewScaleNow(){const H=innerHeight,W=innerWidth;const narrow=W<=760||W/H<0.8;
  const k=narrow?Math.floor(Math.min(H*0.3/136,W*0.5/72)*2)/2:Math.floor(Math.min(H*0.66/136,(W*0.45)/72,CFG.previewScale+1));return Math.max(1,Math.min(k,6));}
function rotate(d){S.dir=(S.dir+d+8)%8;renderPreview();}
async function save_(){
  const p=normalize(S.state,S.bot);p.updated_at=new Date().toISOString();
  S.el.save.disabled=true;
  try{
    localStorage.setItem(storageKey(S.bot),JSON.stringify(p));
    S.saved=p;S.state=normalize(p,S.bot);
    await applyToCity(S.bot,p);
    // shared looks: upsert own row in crew_looks (signed in only); otherwise / on failure it stays on this device
    let msg='Saved on this device',err=false;
    if(typeof hooks.saveRemote==='function'){try{const r=await hooks.saveRemote(p);
        if(r&&r.ok)msg='Saved · everyone in Crew City sees it';
        else if(r&&r.reason==='signed-out')msg='Saved on this device (sign in so everyone sees it)';}
      catch(e){msg='Saved on this device (cloud save failed)';err=true;}}
    setStatus(msg,err);renderRows();
  }catch(e){setStatus('Could not save: '+(e&&e.message||e),true);}
  finally{S.el.save.disabled=false;}
}
function onKey(e){
  if(!S.isOpen)return;
  const k=e.key;
  if(k==='Escape'){close();}
  else if(k==='ArrowUp'||k==='ArrowDown'){S.sel=(S.sel+(k==='ArrowUp'?-1:1)+S.rows.length)%S.rows.length;renderRows();const el=S.el.rows.children[S.sel];if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest'});}
  else if(k==='ArrowLeft'||k==='ArrowRight'){const r=S.rows[S.sel];if(r)step(r,k==='ArrowLeft'?-1:1);}
  else if(k==='q'||k==='Q'){rotate(-1);}else if(k==='e'||k==='E'){rotate(1);}
  else if(k==='Enter'&&!(e.target&&e.target.tagName==='BUTTON')){save_();}
  else return void e.stopImmediatePropagation();
  e.preventDefault();e.stopImmediatePropagation();
}
async function open(){
  await ready;if(!S.data)return false;
  S.bot=ownBot();
  S.rows=buildRows(S.bot);
  S.saved=loadLocal(S.bot);S.state=normalize(S.saved,S.bot);
  S.dir=0;S.sel=Math.max(0,S.rows.findIndex(r=>!r.inert));
  S.isOpen=true;S.el.root.classList.add('open');document.body.classList.add('ccz-on');
  setStatus('');renderRows();await renderPreview();
  clearInterval(S.petTimer);S.petTimer=setInterval(()=>{if(S.isOpen&&S.previewPet)drawPreviewPet();},250);
  return true;
}
function close(){
  if(!S.isOpen)return;S.isOpen=false;S.el.root.classList.remove('open');document.body.classList.remove('ccz-on');clearInterval(S.petTimer);
  if(S.saved&&S.state&&sig(S.state)!==sig(S.saved))setStatus('Closed without saving');
  S.state=S.saved?normalize(S.saved,S.bot):null;
}
function addButton(){
  if(!CFG.autoButton||document.getElementById('cczbtn'))return;
  const hudr=document.getElementById('hudr');if(!hudr)return;
  const b=h('button',null,'CUSTOMISE');b.id='cczbtn';b.type='button';b.setAttribute('aria-label','Customise your look');
  b.addEventListener('click',e=>{e.stopPropagation();open();});
  b.addEventListener('pointerdown',e=>e.stopPropagation());
  hudr.insertBefore(b,hudr.firstChild);
}

const ready=(async()=>{
  try{await loadData();}catch(e){console.warn('[customize] design data not available:',e&&e.message);return false;}
  buildDom();addButton();PET.install();
  addEventListener('keydown',onKey,true);
  addEventListener('keyup',e=>{if(S.isOpen)e.stopImmediatePropagation();},true);
  addEventListener('resize',()=>{if(S.isOpen)renderPreview();});
  // the player's saved look (and pet) shows in the city on load
  const bot=ownBot(),p=loadLocal(bot);
  if(!isDefault(p))await applyToCity(bot,p);
  // shared looks: everyone's saved look + pet (falls back to the local save above when the table is missing)
  S.remoteReady=syncRemote();await Promise.race([S.remoteReady,new Promise(r=>setTimeout(r,4000))]);
  if(CFG.remote&&CFG.remoteRefreshMs>0){setInterval(()=>{if(document.visibilityState!=='hidden'&&!S.isOpen)syncRemote();},CFG.remoteRefreshMs);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!S.isOpen)syncRemote();});}
  return true;
})();

window.CC_CUSTOMIZE={
  ready,open,close,rotate,save:()=>save_(),
  get isOpen(){return S.isOpen;},get bot(){return S.bot||ownBot();},
  get rows(){return S.rows.map(r=>({id:r.id,label:r.label,none:r.none,inert:!!r.inert,options:r.options.map(o=>o.label),keys:r.options.map(o=>o.key),index:S.state?rowIndex(r,S.state):0}));},
  rowsFor:bot=>buildRows(bot||ownBot()).map(r=>({id:r.id,label:r.label,none:r.none,inert:!!r.inert,keys:r.options.map(o=>o.key)})),
  get state(){return S.state&&JSON.parse(JSON.stringify(S.state));},
  get saved(){return S.saved&&JSON.parse(JSON.stringify(S.saved));},
  get applied(){return S.applied&&JSON.parse(JSON.stringify(S.applied));},
  get preview(){return S.lastPreview||null;},
  set(rowId,idx){const r=S.rows.find(x=>x.id===rowId);if(!r||r.inert)return false;S.state=setRow(S.state,r,((idx%r.options.length)+r.options.length)%r.options.length);renderRows();return renderPreview().then(()=>true);},
  pick(rowId,optId){const r=S.rows.find(x=>x.id===rowId);if(!r)return false;const i=r.options.findIndex(o=>o.key===optId);return i<0?false:this.set(rowId,i);},
  step(rowId,d){const r=S.rows.find(x=>x.id===rowId);if(!r)return false;step(r,d||1);return true;},
  normalize:(p,bot)=>normalize(p,bot||ownBot()),defaultPicks:bot=>defaultPicks(bot||ownBot()),compose,applyToCity,
  pet:{get state(){return PET.state();},snap:()=>PET.snap(),tick:dt=>PET.tick(dt),place:(x,y,f)=>PET.place(x,y,f),release:()=>PET.release(),
    recordOrder:()=>PET.recordOrder(),get lastOrder(){return PET.lastOrder;},get sortKey(){return PET.sortKey;},
    get spec(){return PET.P.spec?JSON.parse(JSON.stringify(PET.P.spec)):null;},lineup:(...a)=>PET.lineup(...a),clearLineup:()=>PET.clearLineup()},
  storageKey,loadLocal,hooks,config:CFG,
  shared:{sync:()=>syncRemote(),get table(){return REMOTE.table;},get rows(){return JSON.parse(JSON.stringify(REMOTE.rows));},
    get applied(){return JSON.parse(JSON.stringify(REMOTE.applied));},get stats(){return{loads:REMOTE.loads,saves:REMOTE.saves,status:REMOTE.lastStatus,error:REMOTE.lastError};},
    pet:bot=>{const q=CREW_PETS.get(bot);return q?q.state():null;},get pets(){return[...CREW_PETS.keys()];},
    defaults:{load:loadRemoteDefault,save:saveRemoteDefault}},
  get manifestVersion(){return S.data&&S.data.manifest.version;},
  // own-avatar rule: applying someone else's look from this screen is refused
  applyProfile(p){const bot=ownBot();if(!p||(p.bot&&p.bot!==bot))return Promise.resolve(false);return applyToCity(bot,p);}
};
})();
