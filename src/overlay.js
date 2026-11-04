'use strict';
const { monotonicNow } = require('./core');
class ActionTimeline {
  constructor({now=monotonicNow,retentionMs=()=>2500}={}){this.now=now;this.retentionMs=retentionMs;this.items=new Map();}
  enqueue(action){this.items.set(action.actionId,{...action,status:'pending',expiresAt:Infinity});}
  start(id){const item=this.items.get(id);if(item){item.status='done';item.startedAt=this.now();}}
  finish(id,outcome={}){const item=this.items.get(id);if(item){item.status=outcome.cancelled?'cancelled':outcome.ok===false?'failed':'done';item.expiresAt=this.now()+this.retentionMs();}}
  cancel(){for(const item of this.items.values())if(item.expiresAt===Infinity)this.finish(item.actionId,{cancelled:true});}
  snapshot(){for(const [id,item] of this.items)if(item.expiresAt<=this.now())this.items.delete(id);return [...this.items.values()].map(({expiresAt,...item})=>item);}
}
function overlayBounds(settings,area,count){
  const cell=settings.size+8,horizontal=settings.orientation==='horizontal';
  const width=horizontal?Math.min(area.width-16,Math.max(cell+16,count*cell+16)):cell+16;
  const height=horizontal?cell+16:Math.min(area.height-16,Math.max(cell+16,count*cell+16));
  let x=area.x+(area.width-width)/2,y=area.y;
  if(settings.anchor==='bottom')y=area.y+area.height-height;
  if(settings.anchor==='left'){x=area.x;y=area.y+(area.height-height)/2;}
  if(settings.anchor==='right'){x=area.x+area.width-width;y=area.y+(area.height-height)/2;}
  return {width:Math.round(width),height:Math.round(height),x:Math.round(Math.max(area.x,Math.min(area.x+area.width-width,x+settings.offsetX))),y:Math.round(Math.max(area.y,Math.min(area.y+area.height-height,y+settings.offsetY)))};
}
module.exports={ActionTimeline,overlayBounds};
