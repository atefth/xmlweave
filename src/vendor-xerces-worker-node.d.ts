export interface XercesWorkerTransport {postMessage(message:any):void;terminate():unknown;listen(message:(message:any)=>void,error:(cause:unknown)=>void):void}
export function createXercesWorker(workerURL?:string):XercesWorkerTransport;
