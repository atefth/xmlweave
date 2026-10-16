export interface WorkerTransport { postMessage(message:unknown):void; terminate():unknown; listen(message:(value:any)=>void,error:(cause:unknown)=>void):void }
export function createNodeSchemaWorker(workerURL?:string):WorkerTransport;
