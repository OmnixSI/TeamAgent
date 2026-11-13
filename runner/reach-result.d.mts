export type ReachError={error_kind:string;next_action:string;retry_after?:number;vendor_code?:string;stage?:string};
export type ReachResult={schema_version:number;ok:boolean;channel:string;action:string;backend:string;items:{title:string;text:string;author:string;source_url:string;published_at:string|null}[];meta:{output_truncated?:boolean};error:ReachError|null;source_url:string;fetched_at:string;content_scope:string;completeness_verified:boolean;attempts:any[]};
export const validators:Map<string,(raw:any,request:any)=>string|null>;
export const NEXT_ACTION:Record<string,string>;
export function normalizeReachResult(request:any,raw?:any,options?:{output_truncated?:boolean}):ReachResult;
