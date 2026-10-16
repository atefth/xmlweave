export interface JavaTransport { send(text: string): Promise<void>; next(): Promise<any>; close(): void }
export function startJava(options?: {javaExecutable?: string}): JavaTransport;
