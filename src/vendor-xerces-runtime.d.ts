export interface XercesModule {
 HEAPU8: Uint8Array;
 ccall(name:string, result:string|null, types:readonly string[], values:readonly unknown[], options?:{async?:boolean}): any;
 xmlweaveRead?: (pointer:number, maximum:number)=>Promise<number>;
 xmlweaveEmit?: (event:any)=>Promise<void>;
 xmlweaveDiagnostic?: (event:any)=>void;
 xmlweaveFailed?: boolean;
 xmlweaveFailure?: unknown;
}
export function loadXercesEngine(options?:{wasmUrl?:string}):Promise<XercesModule>;
