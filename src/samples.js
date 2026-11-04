'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
function createSampleStore(directory){
  fs.mkdirSync(directory,{recursive:true});
  const file=(id,extension)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Некорректный образец.');return path.join(directory,id+extension);};
  function list(profileId){return fs.readdirSync(directory).filter(name=>name.endsWith('.json')).flatMap(name=>{try{const value=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));return value.profileId===profileId&&fs.existsSync(file(value.id,'.wav'))?[value]:[];}catch{return[];}}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  function save({profileId,expectedText,samples,sampleRate}){
    if(!(samples instanceof Float32Array)||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>96000||samples.length<sampleRate*.2||samples.length>sampleRate*10||samples.some(x=>!Number.isFinite(x)))throw new Error('Нужна запись от 0,2 до 10 секунд.');
    expectedText=String(expectedText||'').trim();if(!expectedText||expectedText.length>300)throw new Error('Укажите ожидаемые слова записи, до 300 символов.');
    const id=randomUUID(),bytes=Buffer.alloc(44+samples.length*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples.length*2,40);
    for(let i=0;i<samples.length;i++)bytes.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2);
    const meta={id,profileId,expectedText,sampleRate,durationMs:Math.round(samples.length/sampleRate*1000),createdAt:new Date().toISOString()};fs.writeFileSync(file(id,'.wav'),bytes);fs.writeFileSync(file(id,'.json'),JSON.stringify(meta,null,2));return meta;
  }
  function read(id,profileId){const meta=JSON.parse(fs.readFileSync(file(id,'.json'),'utf8'));if(meta.profileId!==profileId)throw new Error('Образец принадлежит другому профилю.');const bytes=fs.readFileSync(file(id,'.wav'));const samples=new Float32Array((bytes.length-44)/2);for(let i=0;i<samples.length;i++)samples[i]=bytes.readInt16LE(44+i*2)/32768;return{...meta,samples};}
  function remove(id,profileId){read(id,profileId);fs.unlinkSync(file(id,'.wav'));fs.unlinkSync(file(id,'.json'));}
  return {list,save,read,remove};
}
module.exports={createSampleStore};
