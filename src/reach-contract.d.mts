export const REACH_BOUNDARY_TEXT:string;
export const CHANNELS:Record<string,{hosts:string[];short:string[];actions:string[]}>;
export function scopeFor(action:string):string;
export function publicSourceUrl(value:unknown):string;
export function safeReachText(value:unknown,max?:number):string;
export function validTarget(channel:unknown,action:unknown,target:unknown):boolean;
