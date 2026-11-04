'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('voiceOverlay',{onUpdate:callback=>ipcRenderer.on('overlay:update',(_event,value)=>callback(value))});
